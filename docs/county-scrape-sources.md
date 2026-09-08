# Texas county scrape sources

Reference for which server / stack each TX county uses when scraping (or is cataloged for).

Generated from `src/cadSources.js` (`CAD_SOURCES_SEED`). **Scrape-ready** means `scrape_strategy = arcgis_rest` and an ArcGIS URL is configured. Other strategies are catalog-only until a scrape path is wired.

_Last updated: 2026-09-08 (v0.3.35)._

## Summary by source type

| Source type | Count | Scrape-ready? |
|-------------|------:|:-------------:|
| BIS public FeatureServer (AGOL) | 145 | yes |
| Pandai MapServer | 23 | yes |
| True Prodigy portal | 10 | no |
| Catalog / investigate | 6 | no |
| TrueAutomation PropAccess only | 4 | no |
| County-hosted MapServer | 3 | yes |
| ArcGIS REST (other host) | 2 | yes |
| Public ArcGIS Online FeatureServer | 2 | yes |
| CAMA.io MapServer | 1 | yes |
| DCAD ParcelQuery MapServer | 1 | yes |
| HCAD Parcels MapServer | 1 | yes |
| RGV911 ESD FeatureServer (mirror) | 1 | yes |
| TrueAutomation MapServer (Bexar-style) | 1 | yes |

**Total TX counties in catalog:** 200  
**Scrape-ready (`arcgis_rest`):** 180  
**Portal / investigate only:** 20

## What the types mean

| Type | What it is |
|------|------------|
| TrueAutomation MapServer (Bexar-style) | Classic PACS ArcGIS MapServer (reference: Bexar `PAMapSearch`). |
| BIS public FeatureServer (AGOL) | BIS Consultants GIS apps exposing `*CADWebService` / similar FeatureServers on ArcGIS Online. |
| Pandai MapServer | Pritchard & Abbott public `*CADPublic` MapServers on `gisdata.pandai.com` (joined TaxParcels + Accounts; often no pagination). |
| DCAD ParcelQuery MapServer | Dallas CAD custom ParcelPublishing layer (`maps.dcad.org`). |
| HCAD Parcels MapServer | Harris County official GIS parcels MapServer. |
| CAMA.io MapServer | CAMA.io-hosted basemap / parcel fabric. |
| County-hosted MapServer | CAD-operated ArcGIS (Lubbock, Williamson, Montgomery/Conroe, etc.). |
| Public ArcGIS Online FeatureServer | AGOL FeatureServer that is not the classic BIS WebService naming. |
| RGV911 ESD FeatureServer (mirror) | Hidalgo scrape uses a third-party ESD parcel mirror (official portal is True Prodigy). |
| ArcGIS REST (other host) | Other ArcGIS REST endpoints not in the buckets above. |
| TrueAutomation PropAccess only | Public ClientDB/mapSearch known; ArcGIS scrape URL not wired yet. |
| True Prodigy portal | Web portal only; no ArcGIS scrape path yet (Cameron has a bulk CSV import path). |
| Catalog / investigate | Placeholder / needs discovery. |

## Counties by source type

### ArcGIS REST (other host) (2)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Travis | `https://gis.traviscountytx.gov/server1/rest/services/Boundaries_and_Jurisdictions/TCAD/Ma…` | `PROP_ID` | `__ALL__` | 0 |
| Wichita | `https://propaccess.wadtx.com/arcgis/rest/services/WCAD/Parcels/MapServer` | `prop_id` | `NBHD` | 1 |

### BIS public FeatureServer (AGOL) (145)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Andrews | `https://utility.arcgis.com/usrsvcs/servers/28dacd7826a04fcd9e3af3f3e6b222d7/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Angelina | `https://utility.arcgis.com/usrsvcs/servers/0d57665b0361492397b48cbd4ad88ad6/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Aransas | `https://utility.arcgis.com/usrsvcs/servers/7541f7b3986c43a98bb534055663ecd5/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Atascosa | `https://utility.arcgis.com/usrsvcs/servers/1f9cc445583d46eb86196061158cfa26/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Austin | `https://utility.arcgis.com/usrsvcs/servers/0545ef6adc754660b8eff3de70da4faa/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Bailey | `https://utility.arcgis.com/usrsvcs/servers/aead775fa2be4aec9dbf8361540e2c6d/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Bandera | `https://utility.arcgis.com/usrsvcs/servers/595df0f11a0e41f5a7e7f49b9624bc05/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Bastrop | `https://utility.arcgis.com/usrsvcs/servers/3c3898a5ef9a46caa69d8fd34de0f488/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Bee | `https://utility.arcgis.com/usrsvcs/servers/c541fd35adc94d16a45063ad86d09fbf/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Bell | `https://utility.arcgis.com/usrsvcs/servers/6efa79e05bde4b98851880b45f63ea52/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Blanco | `https://utility.arcgis.com/usrsvcs/servers/9c7a9f4f7f604ec5b3c57772984b9f4a/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Borden | `https://utility.arcgis.com/usrsvcs/servers/2a7187d3bb6d48afb0147590d6584606/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Bosque | `https://utility.arcgis.com/usrsvcs/servers/d69a51fa458e401382e8f3f772426659/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Brazoria | `https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/BrazoriaCADWebService/…` | `prop_id` | `hood_cd` | 0 |
| Brazos | `https://utility.arcgis.com/usrsvcs/servers/98f1937c14294add94d8d5b2c1f81881/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Brewster | `https://utility.arcgis.com/usrsvcs/servers/1f4e657270584bd8830474bfd16d4eb0/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Brooks | `https://utility.arcgis.com/usrsvcs/servers/f0e6075a5195468889da16a565245904/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Brown | `https://utility.arcgis.com/usrsvcs/servers/0a539aaa7b684b629b57eb2289e2622b/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Burleson | `https://utility.arcgis.com/usrsvcs/servers/a9130afb63844d0fb6fa794d0dd013d8/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Burnet | `https://utility.arcgis.com/usrsvcs/servers/9831c4c543474c5e96bad050824257e3/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Caldwell | `https://services.arcgis.com/rVxY74DxxIDrDbc0/arcgis/rest/services/CaldwellCADWebService/F…` | `prop_id` | `hood_cd` | 0 |
| Calhoun | `https://utility.arcgis.com/usrsvcs/servers/3d52487c23df432aa52490a1d7cd08f3/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Callahan | `https://utility.arcgis.com/usrsvcs/servers/a65b8493743640c1b642629c5233f756/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Camp | `https://utility.arcgis.com/usrsvcs/servers/7d044f659a9043f18ed37720520ee73c/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Cass | `https://utility.arcgis.com/usrsvcs/servers/2155581b557646079caec724163cf55e/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Castro | `https://services5.arcgis.com/iunrO5vjpmI1MJJA/arcgis/rest/services/CastroCADWebService/Fe…` | `prop_id` | `hood_cd` | 0 |
| Cherokee | `https://utility.arcgis.com/usrsvcs/servers/e1c2b56a10d94c30b3827f92762dc3a2/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Cochran | `https://utility.arcgis.com/usrsvcs/servers/0a876c63294540cfbc72b4aec84f8952/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Coke | `https://utility.arcgis.com/usrsvcs/servers/e941caff3b89477da03cece169749ccb/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Coleman | `https://utility.arcgis.com/usrsvcs/servers/086200facb164057869e3f0339bdb8c7/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Collin | `https://services2.arcgis.com/uXyoacYrZTPTKD3R/ArcGIS/rest/services/CCAD_Parcel_Feature_Se…` | `propID` | `nbhdCode` | 4 |
| Colorado | `https://utility.arcgis.com/usrsvcs/servers/c9da7a48402e46aa98fc4c817c3ec51b/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Comal | `https://utility.arcgis.com/usrsvcs/servers/5d37dc8436c24c70aa3cdcec26923b60/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Comanche | `https://utility.arcgis.com/usrsvcs/servers/7bf5a1b3daff4ebf9ce9e3bfe98dc676/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Concho | `https://utility.arcgis.com/usrsvcs/servers/25130dc9fcbe426bb35310fce790963a/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Coryell | `https://utility.arcgis.com/usrsvcs/servers/4ecc64c337814bc3a0886db1810b5f20/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Dallam | `https://utility.arcgis.com/usrsvcs/servers/ee0281431dae4ce09b602d9177c0effd/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Deaf Smith | `https://utility.arcgis.com/usrsvcs/servers/1bf2db0f82c545039f973df35e8317c5/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Delta | `https://utility.arcgis.com/usrsvcs/servers/fa4b2d42bb4d4f4c85068b3deb32a17d/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Dimmit | `https://utility.arcgis.com/usrsvcs/servers/fc5e50e98217462ca878075deac66d77/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Duval | `https://utility.arcgis.com/usrsvcs/servers/f5be9cb68ae9431896bfd15ac20703ff/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Edwards | `https://utility.arcgis.com/usrsvcs/servers/f3531c87ca084095b1b1b81c840b6a57/rest/services…` | `prop_id` | `hood_cd` | 0 |
| El Paso | `https://utility.arcgis.com/usrsvcs/servers/dc78b28373a3426994331e5b1a30c7b9/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Erath | `https://utility.arcgis.com/usrsvcs/servers/dd59a06766d24b79912073c7338722ac/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Falls | `https://utility.arcgis.com/usrsvcs/servers/53ef7c50fb304296814479dcdd077bd0/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Fannin | `https://utility.arcgis.com/usrsvcs/servers/452a26d4f6ac4a928a9d6b703abc05b8/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Fayette | `https://utility.arcgis.com/usrsvcs/servers/d0cd77cc0e5d42cb8959515daf0ddb73/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Franklin | `https://utility.arcgis.com/usrsvcs/servers/1dd7969e04b24b0481a3963189876c4e/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Gaines | `https://utility.arcgis.com/usrsvcs/servers/5e84f61b916e464f997ad82ceee69c12/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Garza | `https://utility.arcgis.com/usrsvcs/servers/e53c6292c01e4fa3bedc30d5eb413949/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Gillespie | `https://utility.arcgis.com/usrsvcs/servers/9a532636cbd34f79b6d9b5c4cc53baff/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Gray | `https://utility.arcgis.com/usrsvcs/servers/d69d7d89f29745739343cece8992ec73/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Grayson | `https://services1.arcgis.com/EVxyUkKpll765a5X/arcgis/rest/services/GraysonWebService/Feat…` | `prop_id_text` | `NeighborhoodCode` | 0 |
| Gregg | `https://utility.arcgis.com/usrsvcs/servers/7c597427b932489a8f5dd2cb64c2440e/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Grimes | `https://utility.arcgis.com/usrsvcs/servers/c35ffea8b2da4f9a84aa5034736b026b/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Guadalupe | `https://utility.arcgis.com/usrsvcs/servers/4a5a0e55fa144e5e966a7a937c925aca/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hale | `https://utility.arcgis.com/usrsvcs/servers/33c9b26ef9944bdb9673a49957634325/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hamilton | `https://utility.arcgis.com/usrsvcs/servers/a81abb5ee464460fbbaa5e3b65fb2d39/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hardin | `https://utility.arcgis.com/usrsvcs/servers/a858795cc1ec49fb87bad6295282a8b7/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Harrison | `https://utility.arcgis.com/usrsvcs/servers/e6112999761448c38be93304678cf0ef/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hartley | `https://utility.arcgis.com/usrsvcs/servers/865a7827a4fa4b369250ab2f61315691/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hays | `https://utility.arcgis.com/usrsvcs/servers/02e3ae8dad2b4fba9d1927407c322e27/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Henderson | `https://utility.arcgis.com/usrsvcs/servers/10ad6530968144dd8694345090df0122/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hill | `https://utility.arcgis.com/usrsvcs/servers/f91ed9bdaa3a4190976c7cd2bddc46c6/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hockley | `https://utility.arcgis.com/usrsvcs/servers/3793d0419da44f28b39060a5cd71aa76/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hood | `https://utility.arcgis.com/usrsvcs/servers/03622a33fdee42ca8a6012ddfa9a8df3/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Howard | `https://utility.arcgis.com/usrsvcs/servers/b93b33feb20140559f02a07be62d88fb/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Hudspeth | `https://utility.arcgis.com/usrsvcs/servers/e3c28f031b2e43febaccf1c06e2dfdbe/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Jackson | `https://utility.arcgis.com/usrsvcs/servers/3eeaabc274694dac85bf12b37a1409d8/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Jasper | `https://utility.arcgis.com/usrsvcs/servers/88e4e1551667478f998591c8569c2d89/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Jefferson | `https://services.arcgis.com/ZXAF35aJr7XcgDMv/arcgis/rest/services/Parcel_JeffersonCAD/Fea…` | `prop_id` | `hood_cd` | 0 |
| Johnson | `https://services5.arcgis.com/SNQMi91A9RRB0qcO/arcgis/rest/services/JohnsonCADWebService/F…` | `prop_id` | `hood_cd` | 0 |
| Kaufman | `https://utility.arcgis.com/usrsvcs/servers/63132138beda4fc0ac36b1eccc370fd8/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Kendall | `https://utility.arcgis.com/usrsvcs/servers/de4dc16a88b54906b070b5aaf72be5ef/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Kenedy | `https://utility.arcgis.com/usrsvcs/servers/9a05f874931f40598c257d473342b48c/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Kerr | `https://utility.arcgis.com/usrsvcs/servers/dcfb21f6cfd84a2cb7951ac64fb50838/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Kimble | `https://utility.arcgis.com/usrsvcs/servers/056cf30189464ea088a249a24067a103/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Kinney | `https://utility.arcgis.com/usrsvcs/servers/97bbde5f49a9410498c3f6bba6ebc876/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Kleberg | `https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/KlebergCADWebService/F…` | `prop_id` | `hood_cd` | 0 |
| Knox | `https://utility.arcgis.com/usrsvcs/servers/310c47040701428284397132aa219b3c/rest/services…` | `prop_id` | `hood_cd` | 0 |
| La Salle | `https://utility.arcgis.com/usrsvcs/servers/539499e765884482a16a9659a00b0993/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Lamar | `https://utility.arcgis.com/usrsvcs/servers/9dfa7f3b93ac4b8b826d900391f16286/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Lamb | `https://utility.arcgis.com/usrsvcs/servers/9333ed860d594e2c923f4af93072fe78/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Lampasas | `https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/LampasasCADWebService/…` | `prop_id` | `hood_cd` | 0 |
| Lavaca | `https://utility.arcgis.com/usrsvcs/servers/a5effe89f2ba47eabc89510447680fb8/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Lee | `https://utility.arcgis.com/usrsvcs/servers/7a49b55f93a74ae0abe91d9949f6af96/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Liberty | `https://utility.arcgis.com/usrsvcs/servers/450c4ebf2346497ca2d3077feca13ee4/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Limestone | `https://utility.arcgis.com/usrsvcs/servers/65f45e0c697a40d49378873ade7fc6a0/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Llano | `https://utility.arcgis.com/usrsvcs/servers/7640f7024cff47a6be21f9632e1d94e7/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Madison | `https://utility.arcgis.com/usrsvcs/servers/1b1d3cca6a2a40d4a12bb96535b86826/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Marion | `https://utility.arcgis.com/usrsvcs/servers/028ec8d2839f4afcb17b04c37e3fac77/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Mason | `https://utility.arcgis.com/usrsvcs/servers/8db3982e95904cc296ca8442af0c4eb5/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Matagorda | `https://utility.arcgis.com/usrsvcs/servers/7b064912351e45bc93aeeccb7aef5fa0/rest/services…` | `prop_id` | `hood_cd` | 0 |
| McMullen | `https://utility.arcgis.com/usrsvcs/servers/6cc67a282e6748b2a4c11ea628bf41aa/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Medina | `https://utility.arcgis.com/usrsvcs/servers/176ee3c2f2e1488fa5e8d782f5e6ede0/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Midland | `https://utility.arcgis.com/usrsvcs/servers/8339294169c14381bcdf05ad8b4d63cc/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Mills | `https://services3.arcgis.com/0xwlcKhzh0RpcMH8/arcgis/rest/services/MillsCADWebService/Fea…` | `prop_id` | `hood_cd` | 0 |
| Mitchell | `https://utility.arcgis.com/usrsvcs/servers/4f4c4df808ee4899b314f33e23806410/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Moore | `https://utility.arcgis.com/usrsvcs/servers/053dea4069674baf97f6b88ee5171b3a/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Newton | `https://utility.arcgis.com/usrsvcs/servers/44dd766353e948eeb6390a4718713409/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Nueces | `https://utility.arcgis.com/usrsvcs/servers/1f43cdaa05ee4c05bfb48b7da6aa4521/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Ochiltree | `https://utility.arcgis.com/usrsvcs/servers/b31480ce47124e9bb37368390a8c2167/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Orange | `https://utility.arcgis.com/usrsvcs/servers/0e8d23989ce140c69b2962ae1da9b768/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Parker | `https://utility.arcgis.com/usrsvcs/servers/fe7855da9ed843c5a5cc7f090447b478/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Parmer | `https://utility.arcgis.com/usrsvcs/servers/4ce1adfa7aee4e469d315499382c812c/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Polk | `https://utility.arcgis.com/usrsvcs/servers/60f9b6d8a8c546b6b0aa1fb4999bee8e/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Presidio | `https://utility.arcgis.com/usrsvcs/servers/ec65f0df88c14a4988805b2f4db6d958/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Rains | `https://utility.arcgis.com/usrsvcs/servers/1e60c8653df84c358ce80b4dde4553e1/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Real | `https://utility.arcgis.com/usrsvcs/servers/d838d2e8092a4aa39dc173cdd1624a4d/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Reeves | `https://services6.arcgis.com/j94FvPaik4etwHFk/arcgis/rest/services/ReevesCADWebService/Fe…` | `prop_id` | `hood_cd` | 0 |
| Robertson | `https://utility.arcgis.com/usrsvcs/servers/520506305882445ca59924b8399f635a/rest/services…` | `prop_id` | `hood_cd` | 0 |
| San Jacinto | `https://utility.arcgis.com/usrsvcs/servers/84ed63a2d4db42f88c67b9a5bd6154e2/rest/services…` | `prop_id` | `hood_cd` | 0 |
| San Patricio | `https://utility.arcgis.com/usrsvcs/servers/0f5863a7a1404cc49f50754869dc6f2d/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Schleicher | `https://utility.arcgis.com/usrsvcs/servers/0af79b0004674f50b3bdb2b5077cd5e8/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Scurry | `https://utility.arcgis.com/usrsvcs/servers/7e0e4b9c22844f8f98176c2824c33922/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Shackelford | `https://utility.arcgis.com/usrsvcs/servers/89a9e0e8eb2a4b6c9680f7bcc0e14b87/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Shelby | `https://utility.arcgis.com/usrsvcs/servers/986e818054724020828b10b3e92cee10/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Starr | `https://utility.arcgis.com/usrsvcs/servers/ff05af4293474b45abf39075250efe78/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Stephens | `https://utility.arcgis.com/usrsvcs/servers/85561de1e8bc4180a7e270ddd36352bb/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Sutton | `https://utility.arcgis.com/usrsvcs/servers/5b6c3c2212d0445991ef56431df50293/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Swisher | `https://utility.arcgis.com/usrsvcs/servers/1951cb0296f34ff3a93de4bca803ce12/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Taylor | `https://services8.arcgis.com/Le0h3rXhunNWxGRi/arcgis/rest/services/BIS_Search_Map/Feature…` | `PROP_ID` | `hood_cd` | 0 |
| Terrell | `https://utility.arcgis.com/usrsvcs/servers/29737156bc454c2fad19f2e475e4aa35/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Terry | `https://utility.arcgis.com/usrsvcs/servers/956e26d1eb17432085d01625ae4d523a/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Titus | `https://utility.arcgis.com/usrsvcs/servers/6efd14c238e04c2b88e8338998b68c1c/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Tom Green | `https://services5.arcgis.com/3KYdtBnAMnav1mt9/arcgis/rest/services/TomGreenCADWebService/…` | `prop_id` | `hood_cd` | 0 |
| Trinity | `https://utility.arcgis.com/usrsvcs/servers/71c66fa7895b4df1bd64675a844ff589/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Tyler | `https://utility.arcgis.com/usrsvcs/servers/f489df5a534948279a993c7f65ac6298/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Upshur | `https://utility.arcgis.com/usrsvcs/servers/82da6c0019344eadbdec9c98acf79cc2/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Uvalde | `https://utility.arcgis.com/usrsvcs/servers/29ac4a4d10d94e779fcccb4566123a3d/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Van Zandt | `https://utility.arcgis.com/usrsvcs/servers/6507af9502de4fb19deb462399672684/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Victoria | `https://utility.arcgis.com/usrsvcs/servers/e65d43a56b124077a7a6eb19ef464e1b/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Walker | `https://utility.arcgis.com/usrsvcs/servers/cc98400b3a414d6a9519d8c7ddf61ffc/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Waller | `https://utility.arcgis.com/usrsvcs/servers/2abd8b401a9d401a9940b891a2d677a4/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Washington | `https://utility.arcgis.com/usrsvcs/servers/06c0f0c3ecbd41feb5ff104cb3c3b627/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Wharton | `https://utility.arcgis.com/usrsvcs/servers/e1377e3b89dd442a9240b63962f7bfcc/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Wilbarger | `https://utility.arcgis.com/usrsvcs/servers/d070c15888884b73a2ae463794426fae/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Willacy | `https://utility.arcgis.com/usrsvcs/servers/4bc982f495e848eca3b3433a64288e14/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Wilson | `https://utility.arcgis.com/usrsvcs/servers/b1f92ace279449d09eaa3d93257da49c/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Wise | `https://utility.arcgis.com/usrsvcs/servers/49a1051e4fca4b1f9b1a8905e9d516f0/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Wood | `https://utility.arcgis.com/usrsvcs/servers/b444eae779694e10a8792a4a4798594a/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Yoakum | `https://utility.arcgis.com/usrsvcs/servers/f8d08b1593eb454cb53c2073004d92c4/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Young | `https://utility.arcgis.com/usrsvcs/servers/dff3fbf2618c416abc7b4e3c6a32ea96/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Zapata | `https://utility.arcgis.com/usrsvcs/servers/71a60f8e7e344c05a034b8f66eb5c453/rest/services…` | `prop_id` | `hood_cd` | 0 |
| Zavala | `https://utility.arcgis.com/usrsvcs/servers/fbae3632f3da40af998a7fdf60079f54/rest/services…` | `prop_id` | `hood_cd` | 0 |

### CAMA.io MapServer (1)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Ector | `https://gis11.cama.io/arcgis/rest/services/Ector/EctorCounty_Basemap/MapServer` | `PIN` | `nh_cd` | 0 |

### Catalog / investigate (6)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| DeWitt | `—` | `pacs_prop_id` | `hood_cd` | — |
| Haskell | `—` | `pacs_prop_id` | `hood_cd` | — |
| Nacogdoches | `—` | `pacs_prop_id` | `hood_cd` | — |
| Somervell | `—` | `pacs_prop_id` | `hood_cd` | — |
| Throckmorton | `—` | `pacs_prop_id` | `hood_cd` | — |
| Upton | `—` | `pacs_prop_id` | `hood_cd` | — |

### County-hosted MapServer (3)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Lubbock | `https://gis.lubbockcad.org/arcgis/rest/services/TaxParcelOrion/MapServer` | `PROP_ID` | `NbhdCode` | 0 |
| Montgomery | `https://maps.cityofconroe.org/cvharcgis/rest/services/ENG/MANAGE_KML_TAX_PARCELS_1051_WGS…` | `PIN` | `NeighborhoodCode` | 0 |
| Williamson | `https://gisweb.wcad.org/server/rest/services/WCADGISDATA/WCADGISDATA/MapServer` | `PropertyID` | `NGHBRHDCD` | 0 |

### DCAD ParcelQuery MapServer (1)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Dallas | `https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer` | `LOWPARCELID` | `NGHBRHDCD` | 4 |

### HCAD Parcels MapServer (1)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Harris | `https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer` | `HCAD_NUM` | `nh_cd` | 0 |

### Pandai MapServer (23)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Chambers | `https://gisdata.pandai.com/pamaps02/rest/services/Chambers/ChambersCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Clay | `https://gisdata.pandai.com/pamaps02/rest/services/Clay/ClayCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Dawson | `https://gisdata.pandai.com/pamaps02/rest/services/Dawson/DawsonCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Eastland | `https://gisdata.pandai.com/pamaps02/rest/services/Eastland/EastlandCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Frio | `https://gisdata.pandai.com/pamaps02/rest/services/Frio/FrioCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Hall | `https://gisdata.pandai.com/pamaps02/rest/services/Hall/HallCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Hansford | `https://gisdata.pandai.com/pamaps02/rest/services/Hansford/HansfordCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Hardeman | `https://gisdata.pandai.com/pamaps02/rest/services/Hardeman/HardemanCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Hemphill | `https://gisdata.pandai.com/pamaps02/rest/services/Hemphill/HemphillCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Hutchinson | `https://gisdata.pandai.com/pamaps02/rest/services/Hutchinson/HutchinsonCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Jack | `https://gisdata.pandai.com/pamaps02/rest/services/Jack/JackCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Jeff Davis | `https://gisdata.pandai.com/pamaps02/rest/services/JeffDavis/JeffDavisCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Jones | `https://gisdata.pandai.com/pamaps02/rest/services/Jones/JonesCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Karnes | `https://gisdata.pandai.com/pamaps02/rest/services/Karnes/KarnesCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Kent | `https://gisdata.pandai.com/pamaps02/rest/services/Kent/KentCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| King | `https://gisdata.pandai.com/pamaps02/rest/services/King/KingCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Live Oak | `https://gisdata.pandai.com/pamaps02/rest/services/LiveOak/LiveOakCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Martin | `https://gisdata.pandai.com/pamaps02/rest/services/Martin/MartinCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| McCulloch | `https://gisdata.pandai.com/pamaps02/rest/services/McCulloch/McCullochCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Menard | `https://gisdata.pandai.com/pamaps02/rest/services/Menard/MenardCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Montague | `https://gisdata.pandai.com/pamaps02/rest/services/Montague/MontagueCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Nolan | `https://gisdata.pandai.com/pamaps02/rest/services/Nolan/NolanCADPublic/MapServer` | `Account` | `Location_Code` | 0 |
| Panola | `https://gisdata.pandai.com/pamaps02/rest/services/Panola/PanolaCADPublic/MapServer` | `Account` | `Location_Code` | 0 |

### Public ArcGIS Online FeatureServer (2)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Fort Bend | `https://services2.arcgis.com/D4saGHECICkCeoJm/arcgis/rest/services/FBCAD_Public_Data/Feat…` | `PROPNUMBER` | `NBHDCODE` | 0 |
| Galveston | `https://services2.arcgis.com/7Zo7vX4Yxo9Z7Vw3/arcgis/rest/services/MyMapService/FeatureSe…` | `PID` | `NBHD` | 0 |

### RGV911 ESD FeatureServer (mirror) (1)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Hidalgo | `https://services2.arcgis.com/HZn9sYWTEUxVRQW9/arcgis/rest/services/Hidalgo_County_ESD_Map…` | `prop_id` | `__ALL__` | 6 |

### True Prodigy portal (10)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Anderson | `www.andersoncad.net` | `pid` | `—` | — |
| Bowie | `bowieappraisal.com` | `pid` | `—` | — |
| Cameron | `cameron.prodigycad.com` | `pid` | `—` | — |
| Denton | `www.dentoncad.com` | `pid` | `—` | — |
| Ellis | `www.elliscad.com` | `pid` | `—` | — |
| Hunt | `hunt-cad.org` | `pid` | `—` | — |
| Maverick | `www.maverickcad.org` | `pid` | `—` | — |
| McLennan | `mclennancad.org` | `pid` | `—` | — |
| Val Verde | `valverdecad.org` | `pid` | `—` | — |
| Webb | `www.webbcad.org` | `pid` | `—` | — |

### TrueAutomation MapServer (Bexar-style) (1)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Bexar | `https://maps.bcad.org/arcgis/rest/services/PAMapSearch/MapServer` | `pacs_prop_id` | `hood_cd` | 9 |

### TrueAutomation PropAccess only (4)

| County | Host / ArcGIS | Prop ID field | Hood field | Layer |
|--------|---------------|---------------|------------|------:|
| Cooke | `propaccess.trueautomation.com` | `pacs_prop_id` | `hood_cd` | — |
| Navarro | `propaccess.trueautomation.com` | `pacs_prop_id` | `hood_cd` | — |
| Rockwall | `propaccess.trueautomation.com` | `pacs_prop_id` | `hood_cd` | — |
| Sherman | `propaccess.trueautomation.com` | `pacs_prop_id` | `hood_cd` | — |

## Full alphabetical table

| County | Source type | Strategy | Vendor / product | Scrape-ready |
|--------|-------------|----------|------------------|--------------|
| Anderson | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| Andrews | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Angelina | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Aransas | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Atascosa | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Austin | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bailey | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bandera | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bastrop | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bee | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bell | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bexar | TrueAutomation MapServer (Bexar-style) | `arcgis_rest` | Harris Govern / PACS | yes |
| Blanco | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Borden | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bosque | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Bowie | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| Brazoria | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Brazos | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Brewster | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Brooks | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Brown | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Burleson | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Burnet | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Caldwell | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Calhoun | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Callahan | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Cameron | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| Camp | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Cass | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Castro | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Chambers | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Cherokee | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Clay | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Cochran | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Coke | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Coleman | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Collin | BIS public FeatureServer (AGOL) | `arcgis_rest` | Collin CAD / ArcGIS Online / CCAD Parcel Feature Set | yes |
| Colorado | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Comal | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Comanche | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Concho | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Cooke | TrueAutomation PropAccess only | `propaccess` | Harris Govern / PACS | no |
| Coryell | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Dallam | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Dallas | DCAD ParcelQuery MapServer | `arcgis_rest` | County CAD / ArcGIS / DCAD ParcelPublishing; maps PARCELID→geo_id, CNTASSDVAL→appraised, OWNERNME1/SITEADDRESS/PRPRTYDSCRP | yes |
| Dawson | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Deaf Smith | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Delta | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Denton | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| DeWitt | Catalog / investigate | `investigate` | Unknown / TBD / Unknown | no |
| Dimmit | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Duval | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Eastland | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Ector | CAMA.io MapServer | `arcgis_rest` | County CAD / ArcGIS / CAMA.io ParcelFabric | yes |
| Edwards | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| El Paso | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Ellis | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| Erath | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Falls | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Fannin | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Fayette | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Fort Bend | Public ArcGIS Online FeatureServer | `arcgis_rest` | County CAD / ArcGIS / FBCAD public AGOL | yes |
| Franklin | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Frio | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Gaines | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Galveston | Public ArcGIS Online FeatureServer | `arcgis_rest` | County CAD / ArcGIS / GCAD web map FS | yes |
| Garza | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Gillespie | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Gray | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Grayson | BIS public FeatureServer (AGOL) | `arcgis_rest` | County CAD / ArcGIS / BIS ExB GraysonWebService | yes |
| Gregg | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Grimes | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Guadalupe | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hale | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hall | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Hamilton | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hansford | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Hardeman | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Hardin | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Harris | HCAD Parcels MapServer | `arcgis_rest` | County CAD / ArcGIS / Official HCAD MapServer | yes |
| Harrison | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hartley | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Haskell | Catalog / investigate | `investigate` | Unknown / TBD / Unknown | no |
| Hays | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hemphill | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Henderson | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hidalgo | RGV911 ESD FeatureServer (mirror) | `arcgis_rest` | True Prodigy (portal) / RGV911 (parcels) / ESD Map Parcels mirror | yes |
| Hill | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hockley | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hood | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Howard | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hudspeth | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Hunt | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| Hutchinson | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Jack | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Jackson | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Jasper | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Jeff Davis | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Jefferson | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Johnson | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Jones | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Karnes | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Kaufman | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Kendall | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Kenedy | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Kent | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Kerr | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Kimble | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| King | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Kinney | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Kleberg | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Knox | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| La Salle | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Lamar | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Lamb | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Lampasas | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Lavaca | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Lee | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Liberty | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Limestone | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Live Oak | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Llano | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Lubbock | County-hosted MapServer | `arcgis_rest` | County CAD / ArcGIS / Lubbock CAD Orion parcels | yes |
| Madison | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Marion | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Martin | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Mason | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Matagorda | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Maverick | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| McCulloch | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| McLennan | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| McMullen | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Medina | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Menard | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Midland | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Mills | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Mitchell | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Montague | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Montgomery | County-hosted MapServer | `arcgis_rest` | County CAD / ArcGIS / Conroe MCAD tax parcels mirror | yes |
| Moore | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Nacogdoches | Catalog / investigate | `investigate` | Unknown / TBD / Unknown | no |
| Navarro | TrueAutomation PropAccess only | `propaccess` | Harris Govern / PACS | no |
| Newton | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Nolan | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Nueces | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Ochiltree | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Orange | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Panola | Pandai MapServer | `arcgis_rest` | Pritchard & Abbott / Pandai / CADPublic MapServer | yes |
| Parker | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Parmer | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Polk | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Presidio | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Rains | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Real | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Reeves | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Robertson | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Rockwall | TrueAutomation PropAccess only | `propaccess` | Harris Govern / PACS | no |
| San Jacinto | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| San Patricio | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Schleicher | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Scurry | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Shackelford | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Shelby | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Sherman | TrueAutomation PropAccess only | `propaccess` | Harris Govern / PACS | no |
| Somervell | Catalog / investigate | `investigate` | Unknown / TBD / Unknown | no |
| Starr | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Stephens | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Sutton | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Swisher | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Taylor | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Terrell | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Terry | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Throckmorton | Catalog / investigate | `investigate` | Unknown / TBD / Unknown | no |
| Titus | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Tom Green | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Travis | ArcGIS REST (other host) | `arcgis_rest` | Travis CAD / County TNR / TCAD Parcels MapServer | yes |
| Trinity | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Tyler | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Upshur | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Upton | Catalog / investigate | `investigate` | Unknown / TBD / Unknown | no |
| Uvalde | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Val Verde | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| Van Zandt | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Victoria | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Walker | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Waller | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Washington | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Webb | True Prodigy portal | `true_prodigy` | True Prodigy / Public Portal / GAMA | no |
| Wharton | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Wichita | ArcGIS REST (other host) | `arcgis_rest` | Harris Govern / PACS | yes |
| Wilbarger | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Willacy | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Williamson | County-hosted MapServer | `arcgis_rest` | County CAD / ArcGIS / WCAD GIS MapServer | yes |
| Wilson | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Wise | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Wood | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Yoakum | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Young | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Zapata | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |
| Zavala | BIS public FeatureServer (AGOL) | `arcgis_rest` | BIS Consultants / Harris Govern / PACS | yes |

## Source-empty / ArcGIS-insufficient counties

These are scrape-wired (`arcgis_rest`) but **cannot be fixed by ArcGIS re-scrape alone** — the public layer itself lacks usable values (or attrs). Notes in `cadSources.js` match. Live-probed 2026-09-08 unless noted.

| Issue | Counties | What the public layer returns |
|-------|----------|-------------------------------|
| Literal `N/A` appraised (prelim) | **Bexar**, **Taylor** | Owners/hoods present; `appraised_val` is the string `N/A` for essentially all parcels until certified values publish |
| Empty BIS value fields | **Robertson**, **Terry**, **Garza** | `file_as_name` / ids often present; `market`, `land_val`, `imprv_val` all null |
| Empty BIS attrs (schema only) | **Johnson** | `JohnsonCADWebService` has owner/value field names but values are blank/null across ~100k parcels; no richer public FeatureServer found |
| Pandai `Market_Value` null | Chambers, Clay, Jones, Nolan, Panola, Jack, McCulloch, Hardeman, Hall, King, Dawson, Hutchinson, Karnes, Hansford, Hemphill, Jeff Davis, Martin, Menard, Kent, Frio (and similar peers) | Public `*CADPublic` MapServer exposes `Market_Value` but it is null; ids/owners may still map |
| Sparse Pandai values | Live Oak | `Market_Value` ~14% `> 0` (~62% non-null); mapper OK — re-scrape will not fill the empty majority |

**Travis** is *not* in this table: switched to Travis County TNR `TCAD` MapServer (owners + `market_value` / `appraised_val`). Former City of Austin `EXTERNAL_tcad_parcel` was geometry/situs-sparse.

## How to refresh this doc

```bash
bun docs/generate-county-scrape-sources.js
```

Source of truth remains `src/cadSources.js`; this markdown is a readable dump for humans. After regenerating, re-apply the **Source-empty / ArcGIS-insufficient counties** section if the generator overwrote it.
