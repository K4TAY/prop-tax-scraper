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
    // --- discovered 2026-09-07 (black-map ArcGIS sweep) ---
    ["Angelina", "angelinacad", "0d57665b0361492397b48cbd4ad88ad6", 60935, null],
    ["Aransas", "aransascad", "7541f7b3986c43a98bb534055663ecd5", 26322, null],
    ["Austin", "austincad", "0545ef6adc754660b8eff3de70da4faa", 22634, null],
    ["Bastrop", "bastropcad", "3c3898a5ef9a46caa69d8fd34de0f488", 65286, null],
    ["Borden", "bordencad", "2a7187d3bb6d48afb0147590d6584606", 3902, null],
    ["Bosque", "bosquecad", "d69a51fa458e401382e8f3f772426659", 20083, null],
    ["Brown", "browncad", "0a539aaa7b684b629b57eb2289e2622b", 31117, null],
    ["Burleson", "burlesoncad", "a9130afb63844d0fb6fa794d0dd013d8", 26162, null],
    ["Burnet", "burnetcad", "9831c4c543474c5e96bad050824257e3", 50656, null, "BurnetCADWebService1"],
    ["Callahan", "callahancad", "a65b8493743640c1b642629c5233f756", 12580, null],
    ["Cochran", "cochrancad", "0a876c63294540cfbc72b4aec84f8952", 5354, null],
    ["Coke", "cokecad", "e941caff3b89477da03cece169749ccb", 7800, null],
    ["Coleman", "colemancad", "086200facb164057869e3f0339bdb8c7", 12489, null],
    ["Comal", "comalcad", "5d37dc8436c24c70aa3cdcec26923b60", 106800, null],
    ["Comanche", "comanchecad", "7bf5a1b3daff4ebf9ce9e3bfe98dc676", 17555, null],
    ["Concho", "conchocad", "25130dc9fcbe426bb35310fce790963a", 8035, null],
    ["Coryell", "coryellcad", "4ecc64c337814bc3a0886db1810b5f20", 31774, null],
    ["Dallam", "dallamcad", "ee0281431dae4ce09b602d9177c0effd", 6518, null],
    ["Delta", "deltacad", "fa4b2d42bb4d4f4c85068b3deb32a17d", 6466, null],
    ["Duval", "duvalcad", "f5be9cb68ae9431896bfd15ac20703ff", 15391, null],
    ["Erath", "erathcad", "dd59a06766d24b79912073c7338722ac", 173514, null],
    ["Franklin", "franklincad", "1dd7969e04b24b0481a3963189876c4e", 16506, null],
    ["Garza", "garzacad", "e53c6292c01e4fa3bedc30d5eb413949", 6602, null],
    ["Gray", "graycad", "d69d7d89f29745739343cece8992ec73", 16329, null],
    ["Grimes", "grimescad", "c35ffea8b2da4f9a84aa5034736b026b", 27335, null],
    ["Harrison", "harrisoncad", "e6112999761448c38be93304678cf0ef", 51318, null],
    ["Hartley", "hartleycad", "865a7827a4fa4b369250ab2f61315691", 5667, null],
    ["Hays", "hayscad", "02e3ae8dad2b4fba9d1927407c322e27", 121700, null, "HaysCADWebService1"],
    ["Henderson", "hendersoncad", "10ad6530968144dd8694345090df0122", 108152, null],
    ["Hood", "hoodcad", "03622a33fdee42ca8a6012ddfa9a8df3", 52221, null],
    ["Howard", "howardcad", "b93b33feb20140559f02a07be62d88fb", 20587, null],
    ["Hudspeth", "hudspethcad", "e3c28f031b2e43febaccf1c06e2dfdbe", 24106, null],
    ["Jasper", "jaspercad", "88e4e1551667478f998591c8569c2d89", 33640, null],
    ["Kenedy", "kenedycad", "9a05f874931f40598c257d473342b48c", 543, null],
    ["Knox", "knoxcad", "310c47040701428284397132aa219b3c", 6408, null],
    ["La Salle", "lasallecad", "539499e765884482a16a9659a00b0993", 9361, null],
    ["Liberty", "libertycad", "450c4ebf2346497ca2d3077feca13ee4", 155905, null],
    ["Limestone", "limestonecad", "65f45e0c697a40d49378873ade7fc6a0", 22115, null],
    ["Llano", "llanocad", "7640f7024cff47a6be21f9632e1d94e7", 37713, null],
    ["Marion", "marioncad", "028ec8d2839f4afcb17b04c37e3fac77", 19345, null],
    ["Midland", "midlandcad", "8339294169c14381bcdf05ad8b4d63cc", 77446, null],
    ["Mitchell", "mitchellcad", "4f4c4df808ee4899b314f33e23806410", 7924, null],
    ["Nueces", "nuecescad", "1f43cdaa05ee4c05bfb48b7da6aa4521", 157044, null],
    ["Ochiltree", "ochiltreecad", "b31480ce47124e9bb37368390a8c2167", 6794, null],
    ["Orange", "orangecad", "0e8d23989ce140c69b2962ae1da9b768", 47397, null],
    ["Parker", "parkercad", "fe7855da9ed843c5a5cc7f090447b478", 102254, null],
    ["Polk", "polkcad", "60f9b6d8a8c546b6b0aa1fb4999bee8e", 59514, null],
    ["Real", "realcad", "d838d2e8092a4aa39dc173cdd1624a4d", 8183, null],
    ["San Patricio", "sanpatriciocad", "0f5863a7a1404cc49f50754869dc6f2d", 49277, null],
    ["Starr", "starrcad", "ff05af4293474b45abf39075250efe78", 40501, null],
    ["Stephens", "stephenscad", "85561de1e8bc4180a7e270ddd36352bb", 13031, null],
    ["Sutton", "suttoncad", "5b6c3c2212d0445991ef56431df50293", 5917, null],
    ["Terry", "terrycad", "956e26d1eb17432085d01625ae4d523a", 9139, null],
    ["Titus", "tituscad", "6efd14c238e04c2b88e8338998b68c1c", 20527, null],
    ["Victoria", "victoriacad", "e65d43a56b124077a7a6eb19ef464e1b", 42679, null],
    ["Waller", "wallercad", "2abd8b401a9d401a9940b891a2d677a4", 53466, null],
    ["Washington", "washingtoncad", "06c0f0c3ecbd41feb5ff104cb3c3b627", 23197, null],
    ["Wharton", "whartoncad", "e1377e3b89dd442a9240b63962f7bfcc", 94444, null],
    ["Wilbarger", "wilbargercad", "d070c15888884b73a2ae463794426fae", 11374, null],
    ["Young", "youngcad", "dff3fbf2618c416abc7b4e3c6a32ea96", 15620, null],
    ["Zapata", "zapatacad", "71a60f8e7e344c05a034b8f66eb5c453", 12570, null],
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

  // BIS-style FeatureServers on public AGOL (utility proxy 403 / missing) — same hood_cd + prop_id
  ...txBisDirectFeatureServers([
    ["Brazoria", "brazoriacad", "https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/BrazoriaCADWebService/FeatureServer", 280302],
    ["Caldwell", "caldwellcad", "https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/CaldwellCADWebService/FeatureServer", 27450],
    ["Castro", "castrocad", "https://services5.arcgis.com/iunrO5vjpmI1MJJA/arcgis/rest/services/CastroCADWebService/FeatureServer", 6594],
    ["Jefferson", "jeffersoncad", "https://services.arcgis.com/ZXAF35aJr7XcgDMv/arcgis/rest/services/Parcel_JeffersonCAD/FeatureServer", 128542],
    ["Johnson", "johnsoncad", "https://services5.arcgis.com/SNQMi91A9RRB0qcO/arcgis/rest/services/JohnsonCADWebService/FeatureServer", 100415],
    ["Kleberg", "klebergcad", "https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/KlebergCADWebService/FeatureServer", 14973],
    ["Lampasas", "lampasascad", "https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/LampasasCADWebService/FeatureServer", 17385],
    ["Mills", "millscad", "https://services3.arcgis.com/0xwlcKhzh0RpcMH8/arcgis/rest/services/MillsCADWebService/FeatureServer", 9059],
    ["Reeves", "reevescad", "https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/ReevesCADWebService/FeatureServer", 23502],
    ["Taylor", "taylorcad", "https://services8.arcgis.com/Le0h3rXhunNWxGRi/arcgis/rest/services/BIS_Search_Map/FeatureServer", 71833, "PROP_ID"],
    ["Tom Green", "tomgreencad", "https://services5.arcgis.com/3KYdtBnAMnav1mt9/arcgis/rest/services/TomGreenCADWebService/FeatureServer", 59021],
  ]),

  // Custom-field public ArcGIS (hood + property id present; not classic BIS schema)
  ...txCustomArcgis([
    ["Dallas", "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer", 4, "NGHBRHDCD", "LOWPARCELID", 844373, "DCAD ParcelPublishing"],
    ["Ector", "https://gis11.cama.io/arcgis/rest/services/Ector/EctorCounty_Basemap/MapServer", 0, "nh_cd", "PIN", 77313, "CAMA.io ParcelFabric"],
    ["Fort Bend", "https://services2.arcgis.com/D4saGHECICkCeoJm/arcgis/rest/services/FBCAD_Public_Data/FeatureServer", 0, "NBHDCODE", "PROPNUMBER", 385781, "FBCAD public AGOL"],
    ["Galveston", "https://services2.arcgis.com/7Zo7vX4Yxo9Z7Vw3/arcgis/rest/services/MyMapService/FeatureServer", 0, "NBHD", "PID", 190731, "GCAD web map FS"],
    ["Grayson", "https://services1.arcgis.com/EVxyUkKpll765a5X/arcgis/rest/services/GraysonWebService/FeatureServer", 0, "NeighborhoodCode", "prop_id_text", 93034, "BIS ExB GraysonWebService"],
    ["Harris", "https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer", 0, "nh_cd", "HCAD_NUM", 1549401, "Official HCAD MapServer"],
    ["Lubbock", "https://gis.lubbockcad.org/arcgis/rest/services/TaxParcelOrion/MapServer", 0, "NbhdCode", "PROP_ID", 131843, "Lubbock CAD Orion parcels"],
    ["Montgomery", "https://maps.cityofconroe.org/cvharcgis/rest/services/ENG/MANAGE_KML_TAX_PARCELS_1051_WGS84/MapServer", 0, "NeighborhoodCode", "PIN", 276557, "Conroe MCAD tax parcels mirror"],
    ["Travis", "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer", 0, "NBHD", "PROP_ID", 386682, "EXTERNAL_tcad_parcel (has NBHD)"],
    ["Williamson", "https://gisweb.wcad.org/server/rest/services/WCADGISDATA/WCADGISDATA/MapServer", 0, "NGHBRHDCD", "PropertyID", 290913, "WCAD GIS MapServer"],
  ]),

  // Pritchard & Abbott pandai MapServers (Location_Code ≈ hood, Account ≈ prop id)
  ...txPandai([
    ["Chambers", "Chambers", 38563],
    ["Clay", "Clay", 13760],
    ["Dawson", "Dawson", 9585],
    ["Eastland", "Eastland", 21492],
    ["Frio", "Frio", 13337],
    ["Hall", "Hall", 6374],
    ["Hansford", "Hansford", 5800],
    ["Hardeman", "Hardeman", 6946],
    ["Hemphill", "Hemphill", 4661],
    ["Hutchinson", "Hutchinson", 19354],
    ["Jack", "Jack", 12460],
    ["Jeff Davis", "JeffDavis", 7174],
    ["Jones", "Jones", 27615],
    ["Karnes", "Karnes", 14612],
    ["Kent", "Kent", 3597],
    ["King", "King", 2325],
    ["Live Oak", "LiveOak", 17112],
    ["Martin", "Martin", 7389],
    ["McCulloch", "McCulloch", 11268],
    ["Menard", "Menard", 5710],
    ["Montague", "Montague", 26663],
    ["Nolan", "Nolan", 13195],
    ["Panola", "Panola", 18890],
  ]),


  // True Prodigy public portal counties (no ArcGIS scrape path yet)
  ...txTrueProdigy([
    ["Anderson", "www.andersoncad.net"],
    ["Bowie", "bowieappraisal.com"],
    ["Denton", "www.dentoncad.com"],
    ["Ellis", "www.elliscad.com"],
    ["Hidalgo", "hidalgo.prodigycad.com"],
    ["Hunt", "hunt-cad.org"],
    ["Maverick", "www.maverickcad.org"],
    ["McLennan", "mclennancad.org"],
    ["Val Verde", "valverdecad.org"],
    ["Webb", "www.webbcad.org"],
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


/**
 * BIS-schema FeatureServers hosted on public AGOL (no working utility.arcgis proxy).
 * Optional 5th element overrides property_id_field (default prop_id).
 */
function txBisDirectFeatureServers(rows) {
  return rows.map((row) => {
    const [county_name, bisSlug, url, parcelCount, propertyIdField] = row;
    return {
      county_name,
      state_code: "TX",
      software_vendor: "BIS Consultants / Harris Govern",
      software_product: "PACS",
      client_id: null,
      property_search_host: "gis.bisclient.com",
      propaccess_base_url: `https://esearch.${bisSlug}.org/`,
      map_search_url: `https://gis.bisclient.com/${bisSlug}/`,
      clientdb_url: `https://esearch.${bisSlug}.org/`,
      arcgis_mapserver_url: url,
      neighborhoods_layer_id: -1,
      properties_layer_id: 0,
      properties_table_name: "Parcels",
      hood_filter_field: "hood_cd",
      property_id_field: propertyIdField || "prop_id",
      scrape_strategy: "arcgis_rest",
      supports_map_search: true,
      supports_propaccess: true,
      supports_arcgis: true,
      same_stack_as_bexar: true,
      notes: `BIS-schema public AGOL FeatureServer (~${parcelCount}). Utility proxy unavailable; using direct URL.`,
      evidence_source: "live_probe",
    };
  });
}

/** Custom-field public ArcGIS Map/FeatureServers with neighborhood + property id. */
function txCustomArcgis(rows) {
  return rows.map((row) => {
    const [county_name, url, layerId, hoodField, propField, parcelCount, label] = row;
    return {
      county_name,
      state_code: "TX",
      software_vendor: "County CAD / ArcGIS",
      software_product: label || "Parcels",
      client_id: null,
      property_search_host: null,
      propaccess_base_url: null,
      map_search_url: null,
      clientdb_url: null,
      arcgis_mapserver_url: url,
      neighborhoods_layer_id: -1,
      properties_layer_id: layerId,
      properties_table_name: "Parcels",
      hood_filter_field: hoodField,
      property_id_field: propField,
      scrape_strategy: "arcgis_rest",
      supports_map_search: true,
      supports_propaccess: false,
      supports_arcgis: true,
      same_stack_as_bexar: false,
      notes: `${label || "Public ArcGIS"} (~${parcelCount}). Custom fields ${hoodField}/${propField}.`,
      evidence_source: "live_probe",
    };
  });
}

/**
 * Pritchard & Abbott pandai public MapServers.
 * Field names are DBO-qualified; scraper uses Location_Code + Account when present.
 */
function txPandai(rows) {
  return rows.map((row) => {
    const [county_name, folder, parcelCount] = row;
    const slug = String(county_name).toLowerCase().replace(/[^a-z0-9]/g, "") + "cad";
    return {
      county_name,
      state_code: "TX",
      software_vendor: "Pritchard & Abbott / Pandai",
      software_product: "CADPublic MapServer",
      client_id: null,
      property_search_host: "gisdata.pandai.com",
      propaccess_base_url: null,
      map_search_url: `https://maps.pandai.com/${folder}CAD/`,
      clientdb_url: null,
      arcgis_mapserver_url: `https://gisdata.pandai.com/pamaps02/rest/services/${folder}/${folder}CADPublic/MapServer`,
      neighborhoods_layer_id: -1,
      properties_layer_id: 0,
      properties_table_name: "Parcels",
      hood_filter_field: "Location_Code",
      property_id_field: "Account",
      scrape_strategy: "arcgis_rest",
      supports_map_search: true,
      supports_propaccess: false,
      supports_arcgis: true,
      same_stack_as_bexar: false,
      notes: `Pandai CADPublic MapServer (~${parcelCount}). Fields are often DBO-qualified (…Accounts.Location_Code / …Accounts.Account); confirm exact names at scrape time.`,
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
