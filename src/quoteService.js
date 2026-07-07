import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const INCLUDED_DC_CABLE_METERS = 30;
const INCLUDED_AC_CABLE_METERS = 10;
const FALLBACK_DAY_START_HOUR = 6;

const FALLBACK_CABLING_TIER = {
  minPanels: 1,
  dcCablePct: 0.27,
  acCablePct: 0.08,
  conduitsPct: 0.12,
  panelBoardPct: 0.09,
};

export async function buildQuote(input) {
  const validationError = validateInput(input);
  if (validationError) {
    throw new Error(validationError);
  }

  const runtime = await loadRuntimeDataFromSupabase();
  const sanitized = sanitizeState(input, runtime.adminParams, runtime);

  const recommendedPanels = computeRecommendedPanels(
    {
      monthlyBill: sanitized.monthlyBill,
      utilityRate: sanitized.utilityRate,
      deviceRows: sanitized.deviceRows,
      desiredSavingsPct: sanitized.desiredSavingsPct,
      phase: sanitized.phase,
    },
    runtime.adminParams,
    runtime,
  );

  const panelCount = Number.isInteger(sanitized.panelCount)
    ? sanitized.panelCount
    : recommendedPanels.recommendedPanelCount;

  const fullState = {
    ...sanitized,
    panelCount,
  };

  const packageData = buildPackageLineItems(fullState, runtime.adminParams, runtime);
  const paymentTerms = computePaymentTerms(fullState, runtime.adminParams, packageData);

  const quotePayload = {
    generatedAt: new Date().toISOString(),
    input: fullState,
    recommendedPanels,
    package: packageData,
    paymentTerms,
  };

  const quoteSignature = createHash('sha256')
    .update(JSON.stringify({ quotePayload, adminParams: runtime.adminParams }))
    .digest('hex');

  return {
    quoteSignature,
    quote: quotePayload,
  };
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Input must be a JSON object.';
  }
  if (!Number.isFinite(Number(input.monthlyBill)) || Number(input.monthlyBill) < 0) {
    return 'monthlyBill must be a non-negative number.';
  }
  if (!Number.isFinite(Number(input.utilityRate)) || Number(input.utilityRate) <= 0) {
    return 'utilityRate must be a positive number.';
  }
  if (!Number.isFinite(Number(input.desiredSavingsPct)) || Number(input.desiredSavingsPct) < 0) {
    return 'desiredSavingsPct must be a non-negative number.';
  }
  if (input.phase !== 'single' && input.phase !== 'three') {
    return 'phase must be either "single" or "three".';
  }
  if (!Number.isInteger(Number(input.tenor)) || Number(input.tenor) < 1) {
    return 'tenor must be a positive integer.';
  }
  if (!Number.isFinite(Number(input.downPaymentPct)) || Number(input.downPaymentPct) < 0) {
    return 'downPaymentPct must be a non-negative number.';
  }
  if (input.deviceRows != null && !Array.isArray(input.deviceRows)) {
    return 'deviceRows must be an array when provided.';
  }
  return null;
}

function sanitizeState(input, adminParams, runtime) {
  const phase = input.phase === 'three' ? 'three' : 'single';
  const panelCount = Number.isFinite(Number(input.panelCount))
    ? Math.max(0, Math.round(Number(input.panelCount)))
    : null;

  const selectedInverters = resolveSelectedInverters(phase, input.selectedInverters, runtime);

  const promoCode = String(input.promoCode || '').trim().toUpperCase();
  const normalizedPromoCode = adminParams.promoCodes.some((p) => p.code === promoCode)
    ? promoCode
    : '';

  return {
    phase,
    monthlyBill: Number(input.monthlyBill),
    utilityRate: Number(input.utilityRate),
    desiredSavingsPct: Number(input.desiredSavingsPct),
    deviceRows: Array.isArray(input.deviceRows) ? input.deviceRows : [],
    panelCount,
    dcCableMeters: Number.isFinite(Number(input.dcCableMeters)) ? Number(input.dcCableMeters) : INCLUDED_DC_CABLE_METERS,
    acCableMeters: Number.isFinite(Number(input.acCableMeters)) ? Number(input.acCableMeters) : INCLUDED_AC_CABLE_METERS,
    rsdEnabled: !!input.rsdEnabled,
    rsdStandalonePanelCount: Number.isFinite(Number(input.rsdStandalonePanelCount))
      ? Math.max(0, Math.round(Number(input.rsdStandalonePanelCount)))
      : 0,
    selectedInverters,
    batteryKwh: Number.isFinite(Number(input.batteryKwh)) ? Math.max(0, Number(input.batteryKwh)) : 0,
    batteryPackageId: input.batteryPackageId ? String(input.batteryPackageId) : undefined,
    roofMaterial: ['metal', 'asphalt', 'concrete'].includes(input.roofMaterial)
      ? input.roofMaterial
      : 'metal',
    location: ['luzon', 'cebu', 'siargao'].includes(input.location)
      ? input.location
      : 'luzon',
    locationKm: Number.isFinite(Number(input.locationKm)) ? Math.max(0, Number(input.locationKm)) : 0,
    miscMaterials: Array.isArray(input.miscMaterials) ? input.miscMaterials : [],
    tenor: Math.round(Number(input.tenor)),
    downPaymentPct: Number(input.downPaymentPct),
    promoCode: normalizedPromoCode,
  };
}

function resolveSelectedInverters(phase, raw, runtime) {
  const inventory = phase === 'three' ? runtime.invertersThreePhase : runtime.invertersSinglePhase;
  const byRatedKw = new Map(inventory.map((inv) => [Number(inv.ratedKw), inv]));
  const rows = Array.isArray(raw) ? raw.slice(0, 3) : [];
  while (rows.length < 3) rows.push(null);

  return rows.map((entry) => {
    if (entry == null) return null;
    const ratedKw = typeof entry === 'number' ? entry : Number(entry?.ratedKw);
    if (!Number.isFinite(ratedKw)) return null;
    return byRatedKw.get(ratedKw) || null;
  });
}

async function loadRuntimeDataFromSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.');
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const singletonTables = [
    'interest_rates',
    'mounting_support',
    'variable_charges',
    'roof_material_rates',
    'location_delivery_charges',
    'rsd_pricing',
    'standalone_retrofit_charges',
    'fixed_overhead',
    'schedule_constants',
    'quote_settings',
    'maintenance_mode',
  ];

  const [
    interestRates,
    mountingSupport,
    variableCharges,
    roofMaterialRates,
    locationDelivery,
    rsdPricing,
    standaloneCharges,
    fixedOverhead,
    scheduleConstants,
    quoteSettings,
    maintenanceMode,
    cablingRows,
    batteryPackages,
    promoCodes,
    devices,
    panelSettings,
    inverters,
    deviceSettings,
  ] = await Promise.all([
    ...singletonTables.map((t) => fetchSingleton(supabase, t)),
    fetchMany(supabase, 'cabling_tiers', 'phase,min_panels,dc_cable_pct,ac_cable_pct,conduits_pct,panel_board_pct', { orderBy: 'min_panels' }),
    fetchMany(supabase, 'battery_packages', 'id,label,battery_unit_kwh,battery_unit_price,battery_rack_capacity,battery_rack_price,ats_price,critical_loads_materials,labor_with_solar_install,standalone_labor,sort_order', { orderBy: 'sort_order' }),
    fetchMany(supabase, 'promo_codes', 'code,label,discount', { orderBy: 'code' }),
    fetchMany(supabase, 'devices', 'name,peak_kw,duty_factor', { orderBy: 'name' }),
    fetchMany(supabase, 'panel_settings', 'phase,panel_watts,panel_direct_price,max_dc_ac_ratio'),
    fetchMany(supabase, 'inverters', 'phase,rated_kw,direct_price', { orderBy: 'rated_kw' }),
    fetchSingletonOptional(supabase, 'device_settings'),
  ]);

  if (!devices.length) throw new Error('No device rows found in devices table.');
  if (!panelSettings.length) throw new Error('No panel settings found in panel_settings table.');
  if (!inverters.length) throw new Error('No inverter rows found in inverters table.');
  if (!batteryPackages.length) throw new Error('No battery package rows found in battery_packages table.');

  const singleTiers = cablingRows
    .filter((r) => r.phase === 'single')
    .map(mapCablingTier);
  const threeTiers = cablingRows
    .filter((r) => r.phase === 'three')
    .map(mapCablingTier);

  const panelSingle = panelSettings.find((p) => p.phase === 'single');
  const panelThree = panelSettings.find((p) => p.phase === 'three');
  if (!panelSingle || !panelThree) {
    throw new Error('panel_settings must include both single and three phase rows.');
  }

  const invertersSinglePhase = inverters
    .filter((i) => i.phase === 'single')
    .map((i) => ({ ratedKw: Number(i.rated_kw), directPrice: Number(i.direct_price) }));
  const invertersThreePhase = inverters
    .filter((i) => i.phase === 'three')
    .map((i) => ({ ratedKw: Number(i.rated_kw), directPrice: Number(i.direct_price) }));
  if (!invertersSinglePhase.length || !invertersThreePhase.length) {
    throw new Error('inverters table must include both single and three phase rows.');
  }

  const runtime = {
    dayStartHour: Number(deviceSettings?.day_start_hour ?? FALLBACK_DAY_START_HOUR),
    devices: devices.map((d) => ({
      name: d.name,
      peakKw: Number(d.peak_kw),
      dutyFactor: Number(d.duty_factor),
    })),
    panelSettings: {
      singlePhase: {
        panelWatts: Number(panelSingle.panel_watts),
        panelDirectPrice: Number(panelSingle.panel_direct_price),
        maxDcAcRatio: Number(panelSingle.max_dc_ac_ratio),
      },
      threePhase: {
        panelWatts: Number(panelThree.panel_watts),
        panelDirectPrice: Number(panelThree.panel_direct_price),
        maxDcAcRatio: Number(panelThree.max_dc_ac_ratio),
      },
    },
    invertersSinglePhase,
    invertersThreePhase,
  };

  runtime.adminParams = {
    baseRtoInterestRate: interestRates.base_rto_interest_rate,
    smallPackagePanelThreshold: interestRates.small_package_panel_threshold,
    smallPackageRiskPremiumBps: interestRates.small_package_risk_premium_bps,
    earlyPayoffDiscountRate: interestRates.early_payoff_discount_rate,
    mountingSupportFloorPrice: mountingSupport.floor_price,
    mountingSupportPctOfPanels: mountingSupport.pct_of_panels,
    cablingTiers: singleTiers,
    cablingTiersThreePhase: threeTiers,
    additionalDcCablePerMeter: variableCharges.additional_dc_cable_per_meter,
    additionalAcCablePerMeter: variableCharges.additional_ac_cable_per_meter,
    laborInstallationPerKwp: variableCharges.labor_installation_per_kwp,
    roofAsphaltPerKwp: roofMaterialRates.asphalt_per_kwp,
    roofConcretePerKwp: roofMaterialRates.concrete_per_kwp,
    cebuFixedFee: locationDelivery.cebu_fixed_fee,
    cebuPerPanel: locationDelivery.cebu_per_panel,
    siargaoFixedFee: locationDelivery.siargao_fixed_fee,
    siargaoPerPanel: locationDelivery.siargao_per_panel,
    luzonOver30FixedFee: locationDelivery.luzon_over30_fixed_fee,
    luzonOver30PerKm: locationDelivery.luzon_over30_per_km,
    rsdVariablePerPanel: rsdPricing.rsd_variable_per_panel,
    rsdFixedTransmitter: rsdPricing.rsd_fixed_transmitter,
    rsdStandaloneLaborPerPanel: standaloneCharges.rsd_standalone_labor_per_panel,
    rsdStandaloneLaborMobilization: standaloneCharges.rsd_standalone_labor_mobilization,
    inverterStandaloneLaborPerUnit: standaloneCharges.inverter_standalone_labor_per_unit,
    inverterStandaloneMobilization: standaloneCharges.inverter_standalone_mobilization,
    fixedOverheadDeliveryLogistics: fixedOverhead.delivery_logistics,
    fixedOverheadWarehouse: fixedOverhead.warehouse,
    fixedOverheadCustoms: fixedOverhead.customs,
    fixedOverheadSafetySupervision: fixedOverhead.safety_supervision,
    fixedOverheadTesting: fixedOverhead.testing,
    batteryPackages: batteryPackages.map((p) => ({
      id: p.id,
      label: p.label,
      batteryUnitKwh: p.battery_unit_kwh,
      batteryUnitPrice: p.battery_unit_price,
      batteryRackCapacity: p.battery_rack_capacity,
      batteryRackPrice: p.battery_rack_price,
      atsPrice: p.ats_price,
      criticalLoadsMaterials: p.critical_loads_materials,
      laborWithSolarInstall: p.labor_with_solar_install,
      standaloneLabor: p.standalone_labor,
    })),
    kWhPerKwpPerDay: scheduleConstants.kwh_per_kwp_per_day,
    batteryEfficiency: scheduleConstants.battery_efficiency,
    batteryDepthOfDischarge: scheduleConstants.battery_depth_of_discharge,
    panelAnnualDegradation: scheduleConstants.panel_annual_degradation,
    lcoeNpvDiscountRate: scheduleConstants.lcoe_npv_discount_rate,
    maintenanceInflationRate: scheduleConstants.maintenance_inflation_rate,
    netMeteringEfficiency: scheduleConstants.net_metering_efficiency,
    preventiveMaintenancePerPanel: scheduleConstants.preventive_maintenance_per_panel,
    preventiveMaintenancePerVisit: scheduleConstants.preventive_maintenance_per_visit,
    minDaysToFirstPostInstallPayment: scheduleConstants.min_days_to_first_post_install_payment,
    promoCodes: promoCodes.map((p) => ({ code: p.code, label: p.label, discount: p.discount })),
    quoteValidityDays: quoteSettings.quote_validity_days,
    gateAuthEnabled: maintenanceMode.gate_auth_enabled,
  };

  return runtime;
}

async function fetchSingletonOptional(supabase, table) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .limit(1)
    .maybeSingle();
  if (error) {
    return null;
  }
  return data || null;
}

function mapCablingTier(row) {
  return {
    minPanels: row.min_panels,
    dcCablePct: row.dc_cable_pct,
    acCablePct: row.ac_cable_pct,
    conduitsPct: row.conduits_pct,
    panelBoardPct: row.panel_board_pct,
  };
}

async function fetchSingleton(supabase, table) {
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase query failed for ${table}: ${error.message}`);
  if (!data) throw new Error(`Missing required row in table ${table}.`);
  return data;
}

async function fetchMany(supabase, table, columns, options = {}) {
  let query = supabase.from(table).select(columns);
  if (options.orderBy) {
    query = query.order(options.orderBy, { ascending: true });
  }
  const { data, error } = await query;
  if (error) throw new Error(`Supabase query failed for ${table}: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

function PMT(rate, nper, pv, fv = 0, type = 0) {
  if (nper === 0) return 0;
  if (rate === 0) return -(pv + fv) / nper;
  const pvif = Math.pow(1 + rate, nper);
  return (-rate * (pv * pvif + fv)) / ((1 + rate * type) * (pvif - 1));
}

function PV(rate, nper, pmt, fv = 0, type = 0) {
  if (rate === 0) return -(pmt * nper + fv);
  const pvif = Math.pow(1 + rate, nper);
  return -(pmt * (1 + rate * type) * (pvif - 1) / rate + fv) / pvif;
}

function effectiveRtoRate(panelCount, adminParams) {
  const premium = panelCount < adminParams.smallPackagePanelThreshold
    ? adminParams.smallPackageRiskPremiumBps / 10000
    : 0;
  return adminParams.baseRtoInterestRate + premium;
}

function deviceMonthlyKwh(device, count, onTime, offTime, daysPerWeek, dayStartHour) {
  if (onTime == null || offTime == null || count == null || count <= 0) {
    return { dayKwh: 0, nightKwh: 0 };
  }

  let dur;
  if (onTime === offTime) dur = 1;
  else if (offTime > onTime) dur = offTime - onTime;
  else dur = offTime + 1 - onTime;

  const shift = dayStartHour / 24;
  const onShifted = ((onTime - shift) % 1 + 1) % 1;
  const dayPiece1 = Math.max(0, Math.min(onShifted + dur, 0.5) - Math.max(onShifted, 0));
  const dayPiece2 = Math.max(0, Math.min(onShifted + dur, 1.5) - Math.max(onShifted, 1));
  const hoursDay = (dayPiece1 + dayPiece2) * 24;
  const nightPiece1 = Math.max(0, Math.min(onShifted + dur, 1.0) - Math.max(onShifted, 0.5));
  const nightPiece2 = Math.max(0, Math.min(onShifted + dur, 2.0) - Math.max(onShifted, 1.5));
  const hoursNight = (nightPiece1 + nightPiece2) * 24;

  const monthlyMultiplier = (daysPerWeek / 7) * (365 / 12);
  const avgKw = device ? device.peakKw * device.dutyFactor : 0;

  return {
    dayKwh: hoursDay * monthlyMultiplier * avgKw * count,
    nightKwh: hoursNight * monthlyMultiplier * avgKw * count,
  };
}

function totalDeviceKwh(deviceRows, runtime) {
  let day = 0;
  let night = 0;
  for (const row of deviceRows) {
    if (!row.deviceName) continue;
    const device = runtime.devices.find((d) => d.name === row.deviceName);
    if (!device) continue;
    const { dayKwh, nightKwh } = deviceMonthlyKwh(
      device,
      row.count,
      row.onTime,
      row.offTime,
      row.daysPerWeek,
      runtime.dayStartHour,
    );
    day += dayKwh;
    night += nightKwh;
  }
  return { totalDeviceDayKwh: day, totalDeviceNightKwh: night };
}

function computeRecommendedPanels(inputs, adminParams, runtime) {
  const { monthlyBill, utilityRate, deviceRows, desiredSavingsPct, phase } = inputs;
  const q25 = monthlyBill / utilityRate;
  const { totalDeviceDayKwh, totalDeviceNightKwh } = totalDeviceKwh(deviceRows, runtime);
  const q26 = totalDeviceDayKwh + totalDeviceNightKwh;
  const q27 = q25 - q26;
  const q28 = q27 / 2 + totalDeviceDayKwh;
  const q29 = q27 / 2 + totalDeviceNightKwh;
  const q31 = q29 / adminParams.batteryEfficiency / adminParams.batteryDepthOfDischarge;
  const q32 = (q28 + q31) * 12 / 365;
  const panelWatts = phase === 'three'
    ? runtime.panelSettings.threePhase.panelWatts
    : runtime.panelSettings.singlePhase.panelWatts;
  const q34 = desiredSavingsPct * q32 * 1000 / panelWatts / adminParams.kWhPerKwpPerDay;
  const w7 = Math.ceil(q34);

  return {
    estMonthlyKwh: q25,
    deviceDayKwh: totalDeviceDayKwh,
    deviceNightKwh: totalDeviceNightKwh,
    deviceTotalKwh: q26,
    baseloadKwh: q27,
    dayTimeKwh: q28,
    nightTimeKwh: q29,
    batteryNightTimeKwh: q31,
    dailyCapacityNeeded: q32,
    rawRecommendation: q34,
    recommendedPanelCount: w7,
    panelWatts,
    inconsistent: q27 < 0,
  };
}

function cablingTotalPct(panelCount, adminParams, phase) {
  const singleTiers = Array.isArray(adminParams.cablingTiers) ? adminParams.cablingTiers : [];
  const threeTiers = Array.isArray(adminParams.cablingTiersThreePhase) ? adminParams.cablingTiersThreePhase : [];
  const tiers = (phase === 'three' && threeTiers.length > 0) ? threeTiers : singleTiers;

  if (tiers.length === 0) {
    const t = FALLBACK_CABLING_TIER;
    return t.dcCablePct + t.acCablePct + t.conduitsPct + t.panelBoardPct;
  }
  let chosen = tiers[0];
  for (const tier of tiers) {
    if (tier.minPanels <= panelCount) chosen = tier;
    else break;
  }
  return chosen.dcCablePct + chosen.acCablePct + chosen.conduitsPct + chosen.panelBoardPct;
}

function panelDirectPrice(phase, runtime) {
  return phase === 'three'
    ? runtime.panelSettings.threePhase.panelDirectPrice
    : runtime.panelSettings.singlePhase.panelDirectPrice;
}

function resolveBatteryPackage(adminParams, batteryPackageId) {
  const list = adminParams?.batteryPackages || [];
  if (batteryPackageId) {
    const match = list.find((p) => p.id === batteryPackageId);
    if (match) return match;
  }
  if (list.length > 0) return list[0];
  return {
    id: 'fallback',
    label: '5 kWh',
    batteryUnitKwh: 5,
    batteryUnitPrice: 0,
    batteryRackCapacity: 3,
    batteryRackPrice: 0,
    atsPrice: 0,
    criticalLoadsMaterials: 0,
    laborWithSolarInstall: 0,
    standaloneLabor: 0,
  };
}

function buildPackageLineItems(state, adminParams, runtime) {
  const {
    phase,
    panelCount,
    dcCableMeters,
    acCableMeters,
    rsdEnabled,
    rsdStandalonePanelCount,
    selectedInverters,
    batteryKwh,
    roofMaterial,
    location,
    locationKm,
    miscMaterials,
  } = state;

  const rtoRate = effectiveRtoRate(panelCount, adminParams);
  const monthlyRate = rtoRate / 12;
  const toRto = (direct) => (direct ? PMT(monthlyRate, 60, -direct, 0, 1) * 60 : 0);

  const panelWatts = phase === 'three'
    ? runtime.panelSettings.threePhase.panelWatts
    : runtime.panelSettings.singlePhase.panelWatts;
  const systemKwp = panelCount * panelWatts / 1000;
  const panelPriceEa = panelDirectPrice(phase, runtime);

  const items = [];
  const panelsTotal = panelCount * panelPriceEa;
  items.push({
    key: 'panels',
    description: `${panelCount} units ${panelWatts}W Solar Panels`,
    directPrice: panelsTotal,
    rto60Price: toRto(panelsTotal),
  });

  const mountingDirect = panelsTotal === 0
    ? 0
    : Math.max(adminParams.mountingSupportFloorPrice, panelsTotal * adminParams.mountingSupportPctOfPanels);
  items.push({
    key: 'mounting',
    description: 'Mounting Support',
    directPrice: mountingDirect,
    rto60Price: toRto(mountingDirect),
  });

  const cablingPct = cablingTotalPct(panelCount, adminParams, phase);
  const cablingDirect = panelsTotal === 0 ? 0 : cablingPct * panelsTotal;
  items.push({
    key: 'cabling',
    description: 'Cables, Conduits, Fittings, Panel Board & Other Devices',
    directPrice: cablingDirect,
    rto60Price: toRto(cablingDirect),
  });

  const dcExtraMeters = Math.max(0, (dcCableMeters || 0) - INCLUDED_DC_CABLE_METERS);
  const dcExtraDirect = panelsTotal === 0 ? 0 : dcExtraMeters * adminParams.additionalDcCablePerMeter;
  items.push({
    key: 'dcExtra',
    description: `${dcExtraMeters}m of Add'l. DC Cable`,
    directPrice: dcExtraDirect,
    rto60Price: toRto(dcExtraDirect),
  });

  const acExtraMeters = Math.max(0, (acCableMeters || 0) - INCLUDED_AC_CABLE_METERS);
  const acExtraDirect = panelsTotal === 0 ? 0 : acExtraMeters * adminParams.additionalAcCablePerMeter;
  items.push({
    key: 'acExtra',
    description: `${acExtraMeters}m of Add'l. AC Cable`,
    directPrice: acExtraDirect,
    rto60Price: toRto(acExtraDirect),
  });

  const fixedOverheadDirect = adminParams.fixedOverheadDeliveryLogistics
    + adminParams.fixedOverheadWarehouse
    + adminParams.fixedOverheadCustoms
    + adminParams.fixedOverheadSafetySupervision
    + adminParams.fixedOverheadTesting;
  const laborDirect = systemKwp * adminParams.laborInstallationPerKwp
    + (panelsTotal === 0 ? 0 : fixedOverheadDirect);
  items.push({
    key: 'labor',
    description: 'Solar Labor & Installation',
    directPrice: laborDirect,
    rto60Price: toRto(laborDirect),
  });

  let rsdDirect = 0;
  if (rsdEnabled && panelsTotal > 0) {
    rsdDirect = panelCount * adminParams.rsdVariablePerPanel + adminParams.rsdFixedTransmitter;
  }
  let rsdStandaloneDirect = 0;
  if (rsdEnabled && panelsTotal === 0 && (rsdStandalonePanelCount || 0) > 0) {
    rsdStandaloneDirect = rsdStandalonePanelCount * adminParams.rsdVariablePerPanel + adminParams.rsdFixedTransmitter;
  }
  let rsdStandaloneLaborDirect = 0;
  if (rsdStandaloneDirect > 0) {
    rsdStandaloneLaborDirect = rsdStandalonePanelCount * adminParams.rsdStandaloneLaborPerPanel
      + adminParams.rsdStandaloneLaborMobilization;
  }
  const rsdPanelsForLabel = Math.max(panelCount, rsdStandalonePanelCount || 0);
  const rsdAnyDirect = rsdDirect + rsdStandaloneDirect;
  items.push({
    key: 'rsd',
    description: `Rapid Shutdown Device (RSD) for ${rsdPanelsForLabel} Solar Panels`,
    directPrice: rsdAnyDirect,
    rto60Price: toRto(rsdAnyDirect),
  });
  items.push({
    key: 'rsdLabor',
    description: 'Labor & Installation for Standalone RSD order',
    directPrice: rsdStandaloneLaborDirect,
    rto60Price: toRto(rsdStandaloneLaborDirect),
  });

  selectedInverters.forEach((inv, i) => {
    const invDirect = inv ? inv.directPrice : 0;
    const desc = inv ? `${Number(inv.ratedKw).toFixed(2)} kW Inverter` : 'None';
    items.push({
      key: `inverter${i}`,
      description: desc,
      directPrice: invDirect,
      rto60Price: toRto(invDirect),
    });
  });

  const pkg = resolveBatteryPackage(adminParams, state.batteryPackageId);
  const batteryCount = (batteryKwh || 0) > 0 ? Math.ceil((batteryKwh || 0) / pkg.batteryUnitKwh) : 0;
  const rackCount = batteryCount > 0 ? Math.ceil(batteryCount / pkg.batteryRackCapacity) : 0;
  const batteryDirect = batteryCount * pkg.batteryUnitPrice;
  const rackDirect = rackCount * pkg.batteryRackPrice;
  const atsDirect = batteryKwh > 0 ? pkg.atsPrice : 0;
  const critLoadDirect = batteryKwh > 0 ? pkg.criticalLoadsMaterials : 0;
  const hasSolar = panelsTotal > 0;
  const battLaborDirect = batteryKwh > 0 ? (hasSolar ? pkg.laborWithSolarInstall : pkg.standaloneLabor) : 0;
  const battLaborLabel = hasSolar
    ? 'Battery Labor & Installation w/ Solar Package Installation'
    : 'Battery Standalone Labor & Installation';

  items.push({
    key: 'battery',
    description: `${batteryCount} unit/s ${pkg.batteryUnitKwh}kWh Battery w/ Cables & Lugs`,
    directPrice: batteryDirect,
    rto60Price: toRto(batteryDirect),
  });
  items.push({
    key: 'rack',
    description: `${rackCount} unit/s Battery Rack`,
    directPrice: rackDirect,
    rto60Price: toRto(rackDirect),
  });
  items.push({
    key: 'ats',
    description: 'Automatic Transfer Switch (ATS)',
    directPrice: atsDirect,
    rto60Price: toRto(atsDirect),
  });
  items.push({
    key: 'critLoads',
    description: 'Materials for Critical Loads',
    directPrice: critLoadDirect,
    rto60Price: toRto(critLoadDirect),
  });
  items.push({
    key: 'batteryLabor',
    description: battLaborLabel,
    directPrice: battLaborDirect,
    rto60Price: toRto(battLaborDirect),
  });

  let invMobDirect = 0;
  const invCount = selectedInverters.filter((i) => i).length;
  if (panelsTotal === 0 && invCount > 0) {
    invMobDirect = adminParams.inverterStandaloneLaborPerUnit * invCount
      + adminParams.inverterStandaloneMobilization;
  }
  items.push({
    key: 'invMob',
    description: 'Mobilization for StandAlone Inverter Order',
    directPrice: invMobDirect,
    rto60Price: toRto(invMobDirect),
  });

  let roofDirect = 0;
  let roofLabel = 'Roof Preparation (Metal - no prep needed)';
  if (panelsTotal > 0) {
    if (roofMaterial === 'asphalt') {
      roofDirect = systemKwp * adminParams.roofAsphaltPerKwp;
      roofLabel = 'Roof Preparation - Asphalt / Shingles / Tiled';
    } else if (roofMaterial === 'concrete') {
      roofDirect = systemKwp * adminParams.roofConcretePerKwp;
      roofLabel = 'Roof Preparation - Concrete';
    }
  }
  items.push({
    key: 'roof',
    description: roofLabel,
    directPrice: roofDirect,
    rto60Price: toRto(roofDirect),
  });

  let locationDirect = 0;
  let locationLabel = 'Location / Delivery - Luzon (within 30km)';
  if (panelsTotal > 0) {
    if (location === 'cebu') {
      locationDirect = adminParams.cebuFixedFee + panelCount * adminParams.cebuPerPanel;
      locationLabel = 'Location / Delivery - Cebu';
    } else if (location === 'siargao') {
      locationDirect = adminParams.siargaoFixedFee + panelCount * adminParams.siargaoPerPanel;
      locationLabel = 'Location / Delivery - Siargao';
    } else if (location === 'luzon' && (locationKm || 0) > 30) {
      locationDirect = adminParams.luzonOver30FixedFee + (locationKm || 0) * adminParams.luzonOver30PerKm;
      locationLabel = `Location / Delivery - Luzon (${locationKm} km from Rizal Park)`;
    }
  }
  items.push({
    key: 'location',
    description: locationLabel,
    directPrice: locationDirect,
    rto60Price: toRto(locationDirect),
  });

  (miscMaterials || []).forEach((row, i) => {
    if (!row.description || !row.count || !row.unitPrice) {
      items.push({ key: `misc${i}`, description: '', directPrice: 0, rto60Price: 0 });
      return;
    }
    const dir = row.count * row.unitPrice;
    items.push({
      key: `misc${i}`,
      description: `${row.count} Unit/s ${row.description}`,
      directPrice: dir,
      rto60Price: toRto(dir),
    });
  });

  const totalDirect = items.reduce((s, i) => s + i.directPrice, 0);
  const totalRto60 = items.reduce((s, i) => s + i.rto60Price, 0);

  return {
    items,
    totalDirect,
    totalRto60,
    rtoRate,
    systemKwp,
    panelPriceEa,
  };
}

function computePaymentTerms(state, adminParams, packageData) {
  const { tenor, downPaymentPct, promoCode } = state;
  const { totalRto60, rtoRate } = packageData;
  const monthlyRate = rtoRate / 12;

  const promo = adminParams.promoCodes.find((p) => p.code === (promoCode || '').trim().toUpperCase());
  const promoDiscount = promo ? promo.discount : 0;
  const discountAmount = -promoDiscount * totalRto60;
  const stepTwoTotalLessDiscount = totalRto60 + discountAmount;

  const directPurchasePrice = PV(monthlyRate, 60, -stepTwoTotalLessDiscount / 60, 0, 1);
  const monthlyForFullPv = PMT(monthlyRate, tenor, -directPurchasePrice, 0, 1);
  const totalPaymentsOverTenor = monthlyForFullPv * tenor;
  const dpAmount = downPaymentPct * totalPaymentsOverTenor;
  const dpTotalCharge = dpAmount;
  const dpFvOneMonth = dpAmount * (1 + monthlyRate);
  const postDpPv = directPurchasePrice - dpFvOneMonth;
  const monthlyAfterDp = PMT(monthlyRate, tenor, -postDpPv, 0, 1);
  const postInstallBalance = totalPaymentsOverTenor - dpAmount;
  const netBalanceOverTenor = monthlyAfterDp * tenor;
  const savingsFromDp = netBalanceOverTenor - postInstallBalance;
  const customerMonthlyPmt = monthlyAfterDp;
  const finalPostInstallBalance = netBalanceOverTenor;
  const totalAmountDue = finalPostInstallBalance + dpTotalCharge;

  return {
    rtoRate,
    promo,
    promoDiscountAmount: discountAmount,
    stepTwoTotalLessDiscount,
    directPurchasePrice,
    monthlyForFullPv,
    totalPaymentsOverTenor,
    epdAmount: totalPaymentsOverTenor - stepTwoTotalLessDiscount,
    dpAmount,
    dpTotalCharge,
    postDpPv,
    monthlyAfterDp,
    customerMonthlyPmt,
    postInstallBalance,
    netBalanceOverTenor,
    savingsFromDp,
    finalPostInstallBalance,
    totalAmountDue,
    negativeBalance: netBalanceOverTenor < 0,
  };
}
