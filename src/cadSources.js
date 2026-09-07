import pool from "./db.js";

/**
 * Catalog of county appraisal / assessor systems that use (or appear to use)
 * Harris Govern / True Automation PACS — the same family as Bexar CAD.
 *
 * Pull-related fields describe how a future scraper can reach each source.
 */

export const CAD_SOURCES_SEED = [
  // Fully mapped (Bexar — our working scrape path)
  {
    county_name: "Bexar",
    state_code: "TX",
    software_vendor: "Harris Govern",
    software_product: "PACS",
    client_id: 110,
    property_search_host: "bexar.trueautomation.com",
    propaccess_base_url: "https://bexar.trueautomation.com/ClientDB/",
    map_search_url: "https://bexar.trueautomation.com/mapSearch/?cid=110",
    clientdb_url: "https://bexar.trueautomation.com/ClientDB/PropertySearch.aspx",
    arcgis_mapserver_url:
      "https://maps.bcad.org/arcgis/rest/services/PAMapSearch/MapServer",
    neighborhoods_layer_id: 8,
    properties_layer_id: 9,
    properties_table_name: "web_map_property",
    hood_filter_field: "hood_cd",
    property_id_field: "pacs_prop_id",
    scrape_strategy: "arcgis_rest",
    supports_map_search: true,
    supports_propaccess: true,
    supports_arcgis: true,
    same_stack_as_bexar: true,
    notes: "Primary reference implementation for this project.",
    evidence_source: "live_scrape",
  },

  // BIS Consultants GIS apps → public *CADWebService FeatureServer
  // Tuple: [county, bisSlug, serverId, parcelCount, clientId, serviceName?]
  ...txBisFeatureServers([
    ["Andrews", "andrewscad", "28dacd7826a04fcd9e3af3f3e6b222d7", 10780, 1],
    ["Atascosa", "atascosacad", "1f9cc445583d46eb86196061158cfa26", 34955, null],
    ["Bailey", "baileycad", "aead775fa2be4aec9dbf8361540e2c6d", 6029, null],
    ["Bandera", "banderacad", "595df0f11a0e41f5a7e7f49b9624bc05", 33094, null],
    ["Bee", "beecad", "c541fd35adc94d16a45063ad86d09fbf", 22538, null],
    ["Bell", "bellcad", "6efa79e05bde4b98851880b45f63ea52", 169406, null],
    ["Blanco", "blancocad", "9c7a9f4f7f604ec5b3c57772984b9f4a", 14736, null],
    ["Brazos", "brazoscad", "98f1937c14294add94d8d5b2c1f81881", 78217, null],
    ["Brewster", "brewstercad", "1f4e657270584bd8830474bfd16d4eb0", 19901, null],
    ["Brooks", "brookscad", "f0e6075a5195468889da16a565245904", 6032, null],
    ["Calhoun", "calhouncad", "3d52487c23df432aa52490a1d7cd08f3", 22667, null],
    ["Camp", "campcad", "7d044f659a9043f18ed37720520ee73c", 11695, null],
    ["Cass", "casscad", "2155581b557646079caec724163cf55e", 35029, 3],
    ["Cherokee", "cherokeecad", "e1c2b56a10d94c30b3827f92762dc3a2", 46892, 61],
    ["Colorado", "coloradocad", "c9da7a48402e46aa98fc4c817c3ec51b", 23003, null],
    ["Deaf Smith", "deafsmithcad", "1bf2db0f82c545039f973df35e8317c5", 10690, null],
    ["Dimmit", "dimmitcad", "fc5e50e98217462ca878075deac66d77", 15603, null],
    ["Edwards", "edwardscad", "f3531c87ca084095b1b1b81c840b6a57", 9608, null],
    ["El Paso", "elpasocad", "dc78b28373a3426994331e5b1a30c7b9", 400899, null],
    ["Falls", "fallscad", "53ef7c50fb304296814479dcdd077bd0", 18786, null],
    ["Fannin", "fannincad", "452a26d4f6ac4a928a9d6b703abc05b8", 29398, null, "FanninCADWebService1"],
    ["Fayette", "fayettecad", "d0cd77cc0e5d42cb8959515daf0ddb73", 23166, null],
    ["Gaines", "gainescad", "5e84f61b916e464f997ad82ceee69c12", 17948, null],
    ["Gillespie", "gillespiecad", "9a532636cbd34f79b6d9b5c4cc53baff", 32432, null],
    ["Gregg", "greggcad", "7c597427b932489a8f5dd2cb64c2440e", 76340, null],
    ["Guadalupe", "guadalupecad", "4a5a0e55fa144e5e966a7a937c925aca", 100092, null],
    ["Hale", "halecad", "33c9b26ef9944bdb9673a49957634325", 18777, null],
    ["Hamilton", "hamiltoncad", "a81abb5ee464460fbbaa5e3b65fb2d39", 14022, null],
    ["Hardin", "hardincad", "a858795cc1ec49fb87bad6295282a8b7", 42192, null],
    ["Hill", "hillcad", "f91ed9bdaa3a4190976c7cd2bddc46c6", 39119, null],
    ["Hockley", "hockleycad", "3793d0419da44f28b39060a5cd71aa76", 16741, null],
    ["Jackson", "jacksoncad", "3eeaabc274694dac85bf12b37a1409d8", 16822, null],
    ["Kaufman", "kaufmancad", "63132138beda4fc0ac36b1eccc370fd8", 99825, null],
    ["Kendall", "kendallcad", "de4dc16a88b54906b070b5aaf72be5ef", 31312, null],
    ["Kerr", "kerrcad", "dcfb21f6cfd84a2cb7951ac64fb50838", 36654, null],
    ["Kimble", "kimblecad", "056cf30189464ea088a249a24067a103", 9674, null],
    ["Kinney", "kinneycad", "97bbde5f49a9410498c3f6bba6ebc876", 10745, null],
    ["Lamar", "lamarcad", "9dfa7f3b93ac4b8b826d900391f16286", 36498, null],
    ["Lamb", "lambcad", "9333ed860d594e2c923f4af93072fe78", 13775, null],
    ["Lavaca", "lavacacad", "a5effe89f2ba47eabc89510447680fb8", 19900, null],
    ["Lee", "leecad", "7a49b55f93a74ae0abe91d9949f6af96", 15332, null],
    ["Madison", "madisoncad", "1b1d3cca6a2a40d4a12bb96535b86826", 10195, null],
    ["Mason", "masoncad", "8db3982e95904cc296ca8442af0c4eb5", 8831, null],
    ["Matagorda", "matagordacad", "7b064912351e45bc93aeeccb7aef5fa0", 37219, null],
    ["McMullen", "mcmullencad", "6cc67a282e6748b2a4c11ea628bf41aa", 4154, null],
    ["Medina", "medinacad", "176ee3c2f2e1488fa5e8d782f5e6ede0", 46936, null],
    ["Moore", "moorecad", "053dea4069674baf97f6b88ee5171b3a", 11980, null],
    ["Newton", "newtoncad", "44dd766353e948eeb6390a4718713409", 23174, null],
    ["Parmer", "parmercad", "4ce1adfa7aee4e469d315499382c812c", 6586, null],
    ["Presidio", "presidiocad", "ec65f0df88c14a4988805b2f4db6d958", 19258, null],
    ["Rains", "rainscad", "1e60c8653df84c358ce80b4dde4553e1", 12420, null],
    ["Robertson", "robertsoncad", "520506305882445ca59924b8399f635a", 17296, null],
    ["San Jacinto", "sanjacintocad", "84ed63a2d4db42f88c67b9a5bd6154e2", 35936, null],
    ["Schleicher", "schleichercad", "0af79b0004674f50b3bdb2b5077cd5e8", 6451, null],
    ["Scurry", "scurrycad", "7e0e4b9c22844f8f98176c2824c33922", 13568, null],
    ["Shackelford", "shackelfordcad", "89a9e0e8eb2a4b6c9680f7bcc0e14b87", 5560, null],
    ["Shelby", "shelbycad", "986e818054724020828b10b3e92cee10", 20375, null],
    ["Swisher", "swishercad", "1951cb0296f34ff3a93de4bca803ce12", 6467, null],
    ["Terrell", "terrellcad", "29737156bc454c2fad19f2e475e4aa35", 5545, null],
    ["Trinity", "trinitycad", "71c66fa7895b4df1bd64675a844ff589", 25936, null],
    ["Tyler", "tylercad", "f489df5a534948279a993c7f65ac6298", 31418, null],
    ["Upshur", "upshurcad", "82da6c0019344eadbdec9c98acf79cc2", 29183, 55],
    ["Uvalde", "uvaldecad", "29ac4a4d10d94e779fcccb4566123a3d", 21727, null],
    ["Van Zandt", "vanzandtcad", "6507af9502de4fb19deb462399672684", 43949, null],
    ["Walker", "walkercad", "cc98400b3a414d6a9519d8c7ddf61ffc", 36813, null],
    ["Willacy", "willacycad", "4bc982f495e848eca3b3433a64288e14", 14171, null],
    ["Wilson", "wilsoncad", "b1f92ace279449d09eaa3d93257da49c", 29091, null],
    ["Wise", "wisecad", "49a1051e4fca4b1f9b1a8905e9d516f0", 52929, null],
    ["Wood", "woodcad", "b444eae779694e10a8792a4a4798594a", 44495, null],
    ["Yoakum", "yoakumcad", "f8d08b1593eb454cb53c2073004d92c4", 7223, null],
    ["Zavala", "zavalacad", "fbae3632f3da40af998a7fdf60079f54", 9647, null],
  ]),

  // Out of state — PropertyAccess host
  {
    county_name: "Flagler",
    state_code: "FL",
    software_vendor: "Harris Govern",
    software_product: "PACS",
    client_id: null,
    property_search_host: "propertysearch.trueautomation.com",
    propaccess_base_url: "https://propertysearch.trueautomation.com/PropertyAccess/",
    map_search_url: null,
    clientdb_url: null,
    scrape_strategy: "property_access",
    supports_map_search: false,
    supports_propaccess: true,
    supports_arcgis: false,
    same_stack_as_bexar: true,
    notes: "Florida Property Appraiser; PACS go-live noted in Harris Govern newsletter.",
    evidence_source: "harris_newsletter",
  },
  {
    county_name: "Asotin",
    state_code: "WA",
    software_vendor: "Harris Govern",
    software_product: "PACS",
    client_id: 10,
    property_search_host: "propertysearch.trueautomation.com",
    propaccess_base_url:
      "https://propertysearch.trueautomation.com/PropertyAccess/?cid=10",
    map_search_url:
      "https://propertysearch.trueautomation.com/PropertyAccess/mapSearch/?cid=10",
    clientdb_url:
      "https://propertysearch.trueautomation.com/PropertyAccess/PropertySearch.aspx?cid=10",
    scrape_strategy: "property_access",
    supports_map_search: true,
    supports_propaccess: true,
    supports_arcgis: false,
    same_stack_as_bexar: true,
    notes: "Washington Assessor PropertyAccess portal.",
    evidence_source: "county_website",
  },
  {
    county_name: "Stevens",
    state_code: "WA",
    software_vendor: "Harris Govern",
    software_product: "PACS",
    client_id: 0,
    property_search_host: "propertysearch.trueautomation.com",
    propaccess_base_url:
      "https://propertysearch.trueautomation.com/PropertyAccess/",
    map_search_url:
      "https://propertysearch.trueautomation.com/PropertyAccess/mapSearch/",
    clientdb_url:
      "https://propertysearch.trueautomation.com/PropertyAccess/PropertySearch.aspx",
    scrape_strategy: "property_access",
    supports_map_search: true,
    supports_propaccess: true,
    supports_arcgis: false,
    same_stack_as_bexar: true,
    notes: "Default PropertyAccess host lands on Stevens County.",
    evidence_source: "live_portal",
  },

  // Texas — PropAccess cid known; public ArcGIS scrape endpoint still missing
  {
    ...txPropaccessEntry("Navarro", 91),
  },
  {
    ...txPropaccessEntry("Sherman", 53),
  },
  {
    ...txPropaccessEntry("Cooke", 6),
    map_search_url: "https://gis.bisclient.com/cookecad/",
    notes:
      "PropAccess cid=6. Also has True Prodigy office lookup on cookecad.org and a BIS GIS app, but no public utility.arcgis FeatureServer id discovered yet for arcgis_rest.",
    evidence_source: "live_probe",
  },
  {
    ...txPropaccessEntry("Rockwall", 42),
    propaccess_base_url: "https://propaccess.trueautomation.com/clientdb/?cid=42",
    notes:
      "PropAccess cid=42. Also runs True Prodigy public portal at rockwallcad.com — needs separate true_prodigy scraper; ArcGIS MapServer not yet wired.",
    evidence_source: "live_probe",
  },

  // Collin — public AGOL FeatureServer (not BIS utility proxy)
  {
    county_name: "Collin",
    state_code: "TX",
    software_vendor: "Collin CAD / ArcGIS Online",
    software_product: "CCAD Parcel Feature Set",
    client_id: null,
    property_search_host: "www.collincad.org",
    propaccess_base_url: "https://www.collincad.org/",
    map_search_url: "https://gis.bisclient.com/collincad/",
    clientdb_url: "https://www.collincad.org/",
    arcgis_mapserver_url:
      "https://services2.arcgis.com/uXyoacYrZTPTKD3R/ArcGIS/rest/services/CCAD_Parcel_Feature_Set/FeatureServer",
    neighborhoods_layer_id: -1,
    properties_layer_id: 4,
    properties_table_name: "Parcels",
    hood_filter_field: "nbhdCode",
    property_id_field: "propID",
    scrape_strategy: "arcgis_rest",
    supports_map_search: true,
    supports_propaccess: false,
    supports_arcgis: true,
    same_stack_as_bexar: false,
    notes:
      "Public AGOL FeatureServer (~434k parcels). Hoods from distinct nbhdCode; field names are camelCase (ownerName, geoID, situsConcat). Not TrueAutomation PropAccess.",
    evidence_source: "live_probe",
  },

  // Wichita — TrueAutomation ClientDB + public Parcels MapServer (NBHD field)
  {
    county_name: "Wichita",
    state_code: "TX",
    software_vendor: "Harris Govern",
    software_product: "PACS",
    client_id: 1,
    property_search_host: "propaccess.wadtx.com",
    propaccess_base_url: "https://propaccess.wadtx.com/clientdb/?cid=1",
    map_search_url: "https://gis.bisclient.com/wichitacad/",
    clientdb_url: "https://propaccess.wadtx.com/clientdb/?cid=1",
    arcgis_mapserver_url:
      "https://propaccess.wadtx.com/arcgis/rest/services/WCAD/Parcels/MapServer",
    neighborhoods_layer_id: -1,
    properties_layer_id: 1,
    properties_table_name: "prop_id",
    hood_filter_field: "NBHD",
    property_id_field: "prop_id",
    scrape_strategy: "arcgis_rest",
    supports_map_search: true,
    supports_propaccess: true,
    supports_arcgis: true,
    same_stack_as_bexar: true,
    notes:
      "Custom TrueAutomation host. Attribute-rich parcels layer is MapServer/1 (not /0). Neighborhood field is NBHD (~58k parcels).",
    evidence_source: "live_probe",
  },

  // True Prodigy public portal counties (no ArcGIS scrape path yet)
  ...txTrueProdigy([
    ["Webb", "www.webbcad.org"],
    ["Denton", "www.dentoncad.com"],
    ["Ellis", "www.elliscad.com"],
    ["Hunt", "hunt-cad.org"],
    ["Maverick", "www.maverickcad.org"],
    ["McLennan", "mclennancad.org"],
  ]),

  // Still unresolved — probed 2026-09-07
  ...txUnknownCid([
    "DeWitt",
    "Haskell",
    "Nacogdoches",
    "Somervell",
    "Throckmorton",
    "Upton",
  ]),
];

/**
 * BIS Consultants GIS apps hosting a public *CADWebService FeatureServer.
 * Parcels layer 0 has hood_cd + prop_id (same import path as Calhoun).
 * Optional 6th tuple element overrides the default `{County}CADWebService` name.
 */
function txBisFeatureServers(rows) {
  return rows.map((row) => {
    const [county_name, bisSlug, serverId, parcelCount, clientId, serviceName] = row;
    const service =
      serviceName || `${String(county_name).replace(/ /g, "")}CADWebService`;
    return {
      county_name,
      state_code: "TX",
      software_vendor: "BIS Consultants / Harris Govern",
      software_product: "PACS",
      client_id: clientId,
      property_search_host: "gis.bisclient.com",
      propaccess_base_url: `https://esearch.${bisSlug}.org/`,
      map_search_url: `https://gis.bisclient.com/${bisSlug}/`,
      clientdb_url: `https://esearch.${bisSlug}.org/`,
      arcgis_mapserver_url: `https://utility.arcgis.com/usrsvcs/servers/${serverId}/rest/services/${service}/FeatureServer`,
      neighborhoods_layer_id: -1,
      properties_layer_id: 0,
      properties_table_name: "Parcels",
      hood_filter_field: "hood_cd",
      property_id_field: "prop_id",
      scrape_strategy: "arcgis_rest",
      supports_map_search: true,
      supports_propaccess: true,
      supports_arcgis: true,
      same_stack_as_bexar: true,
      notes: `BIS GIS map; public FeatureServer parcels (~${parcelCount}). Hoods derived from distinct hood_cd.`,
      evidence_source: "live_probe",
    };
  });
}

function txPropaccessEntry(county_name, client_id) {
  return {
    county_name,
    state_code: "TX",
    software_vendor: "Harris Govern",
    software_product: "PACS",
    client_id,
    property_search_host: "propaccess.trueautomation.com",
    propaccess_base_url: `https://propaccess.trueautomation.com/clientdb/?cid=${client_id}`,
    map_search_url: `https://propaccess.trueautomation.com/mapSearch/?cid=${client_id}`,
    clientdb_url: `https://propaccess.trueautomation.com/clientDB/PropertySearch.aspx?cid=${client_id}`,
    arcgis_mapserver_url: null,
    neighborhoods_layer_id: null,
    properties_layer_id: null,
    properties_table_name: null,
    hood_filter_field: "hood_cd",
    property_id_field: "pacs_prop_id",
    scrape_strategy: "propaccess",
    supports_map_search: true,
    supports_propaccess: true,
    supports_arcgis: false,
    same_stack_as_bexar: true,
    notes:
      "Public ClientDB cid known. ArcGIS MapServer URL not yet discovered — probe CAD GIS if adding a scraper.",
    evidence_source: "propaccess_cid",
  };
}

function txPropaccess(pairs) {
  return pairs.map(([county_name, client_id]) => txPropaccessEntry(county_name, client_id));
}

/** True Prodigy CAD public portal counties (webbcad-style). */
function txTrueProdigy(pairs) {
  return pairs.map(([county_name, host]) => {
    const h = String(host).replace(/^https?:\/\//, "").replace(/\/$/, "");
    return {
      county_name,
      state_code: "TX",
      software_vendor: "True Prodigy",
      software_product: "Public Portal / GAMA",
      client_id: null,
      property_search_host: h,
      propaccess_base_url: `https://${h}/`,
      map_search_url: `https://${h}/maps`,
      clientdb_url: `https://${h}/property-search`,
      arcgis_mapserver_url: null,
      neighborhoods_layer_id: null,
      properties_layer_id: null,
      properties_table_name: null,
      hood_filter_field: null,
      property_id_field: "pid",
      scrape_strategy: "true_prodigy",
      supports_map_search: true,
      supports_propaccess: false,
      supports_arcgis: false,
      same_stack_as_bexar: false,
      notes:
        `True Prodigy portal (office confirmed via officelookup on ${h}). API host prod-container.trueprodigyapi.com. Parcel GIS is GAMA/PostGIS tiles, not public ArcGIS FeatureServer. Needs a true_prodigy scraper — current arcgis_rest pipeline cannot import.`,
      evidence_source: "live_probe",
    };
  });
}

function txUnknownCid(names) {
  const extras = {
    DeWitt: "No True Prodigy office hit; no BIS GIS slug. Confirm CAD vendor and public GIS before scrape.",
    Haskell: "No True Prodigy office hit; no BIS GIS slug. Confirm CAD vendor and public GIS before scrape.",
    Nacogdoches: "esearch.nacocad.org responds (BIS-style esearch). No public FeatureServer id discovered yet.",
    Somervell: "No True Prodigy office hit; no BIS GIS slug. Confirm CAD vendor and public GIS before scrape.",
    Throckmorton: "BIS GIS app at gis.bisclient.com/throckmortoncad exists (Experience Builder). No public FeatureServer id extracted yet.",
    Upton: "No True Prodigy office hit; no BIS GIS slug. Confirm CAD vendor and public GIS before scrape.",
  };
  return names.map((county_name) => ({
    county_name,
    state_code: "TX",
    software_vendor: "Unknown / TBD",
    software_product: "Unknown",
    client_id: null,
    property_search_host: null,
    propaccess_base_url: null,
    map_search_url: null,
    clientdb_url: null,
    arcgis_mapserver_url: null,
    neighborhoods_layer_id: null,
    properties_layer_id: null,
    properties_table_name: null,
    hood_filter_field: "hood_cd",
    property_id_field: "pacs_prop_id",
    scrape_strategy: "investigate",
    supports_map_search: null,
    supports_propaccess: null,
    supports_arcgis: null,
    same_stack_as_bexar: false,
    notes:
      extras[county_name] ||
      "Catalog placeholder. Resolve vendor, client_id, and ArcGIS/True Prodigy endpoints before scraping.",
    evidence_source: "live_probe",
  }));
}

export async function ensureCadSourcesSchema(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS cad_sources (
      id SERIAL PRIMARY KEY,
      county_name TEXT NOT NULL,
      state_code CHAR(2) NOT NULL,
      software_vendor TEXT NOT NULL DEFAULT 'Harris Govern',
      software_product TEXT NOT NULL DEFAULT 'PACS',
      -- How to reach the public property search
      client_id INTEGER,
      property_search_host TEXT,
      propaccess_base_url TEXT,
      map_search_url TEXT,
      clientdb_url TEXT,
      -- ArcGIS REST (Bexar-style neighborhood → property export)
      arcgis_mapserver_url TEXT,
      neighborhoods_layer_id INTEGER,
      properties_layer_id INTEGER,
      properties_table_name TEXT,
      hood_filter_field TEXT DEFAULT 'hood_cd',
      property_id_field TEXT DEFAULT 'pacs_prop_id',
      -- Pull playbook
      scrape_strategy TEXT NOT NULL DEFAULT 'investigate',
      -- investigate | arcgis_rest | propaccess | property_access | mapsearch | true_prodigy | unknown
      supports_map_search BOOLEAN,
      supports_propaccess BOOLEAN,
      supports_arcgis BOOLEAN,
      same_stack_as_bexar BOOLEAN NOT NULL DEFAULT TRUE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT,
      evidence_source TEXT,
      last_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (county_name, state_code)
    );

    CREATE INDEX IF NOT EXISTS cad_sources_state_idx ON cad_sources (state_code);
    CREATE INDEX IF NOT EXISTS cad_sources_strategy_idx ON cad_sources (scrape_strategy);
    CREATE INDEX IF NOT EXISTS cad_sources_client_id_idx ON cad_sources (client_id);
  `);
}

export async function seedCadSources(client = pool, { rows = CAD_SOURCES_SEED } = {}) {
  await ensureCadSourcesSchema(client);
  let upserted = 0;
  for (const row of rows) {
    await client.query(
      `
      INSERT INTO cad_sources (
        county_name, state_code, software_vendor, software_product,
        client_id, property_search_host, propaccess_base_url, map_search_url, clientdb_url,
        arcgis_mapserver_url, neighborhoods_layer_id, properties_layer_id, properties_table_name,
        hood_filter_field, property_id_field, scrape_strategy,
        supports_map_search, supports_propaccess, supports_arcgis, same_stack_as_bexar,
        notes, evidence_source, last_verified_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,$9,
        $10,$11,$12,$13,
        $14,$15,$16,
        $17,$18,$19,$20,
        $21,$22,
        CASE WHEN $16 = 'arcgis_rest' THEN NOW() ELSE NULL END,
        NOW()
      )
      ON CONFLICT (county_name, state_code) DO UPDATE SET
        software_vendor = EXCLUDED.software_vendor,
        software_product = EXCLUDED.software_product,
        client_id = EXCLUDED.client_id,
        property_search_host = EXCLUDED.property_search_host,
        propaccess_base_url = EXCLUDED.propaccess_base_url,
        map_search_url = EXCLUDED.map_search_url,
        clientdb_url = EXCLUDED.clientdb_url,
        arcgis_mapserver_url = EXCLUDED.arcgis_mapserver_url,
        neighborhoods_layer_id = EXCLUDED.neighborhoods_layer_id,
        properties_layer_id = EXCLUDED.properties_layer_id,
        properties_table_name = EXCLUDED.properties_table_name,
        hood_filter_field = EXCLUDED.hood_filter_field,
        property_id_field = EXCLUDED.property_id_field,
        scrape_strategy = EXCLUDED.scrape_strategy,
        supports_map_search = EXCLUDED.supports_map_search,
        supports_propaccess = EXCLUDED.supports_propaccess,
        supports_arcgis = EXCLUDED.supports_arcgis,
        same_stack_as_bexar = EXCLUDED.same_stack_as_bexar,
        notes = EXCLUDED.notes,
        evidence_source = EXCLUDED.evidence_source,
        last_verified_at = CASE
          WHEN EXCLUDED.scrape_strategy = 'arcgis_rest' THEN NOW()
          ELSE cad_sources.last_verified_at
        END,
        updated_at = NOW()
      `,
      [
        row.county_name,
        row.state_code,
        row.software_vendor || "Harris Govern",
        row.software_product || "PACS",
        row.client_id ?? null,
        row.property_search_host ?? null,
        row.propaccess_base_url ?? null,
        row.map_search_url ?? null,
        row.clientdb_url ?? null,
        row.arcgis_mapserver_url ?? null,
        row.neighborhoods_layer_id ?? null,
        row.properties_layer_id ?? null,
        row.properties_table_name ?? null,
        row.hood_filter_field ?? "hood_cd",
        row.property_id_field ?? "pacs_prop_id",
        row.scrape_strategy || "investigate",
        row.supports_map_search ?? null,
        row.supports_propaccess ?? null,
        row.supports_arcgis ?? null,
        row.same_stack_as_bexar !== false,
        row.notes ?? null,
        row.evidence_source ?? null,
      ]
    );
    upserted += 1;
  }
  return upserted;
}
