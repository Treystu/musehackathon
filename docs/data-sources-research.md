# CivicScope — Enrichment Data Sources (research notes)

Human planning note for `docs/`. Not shipped source; checkmarks and arrows are fine here.

This is a candidate-research inventory, not approval to ingest data. Current priorities,
dispositions, evidence owners, and architecture constraints are in
[the canonical backlog](canon-work-mission.md). Do not treat a verdict below as permission
to add a source, bundle records, or add an input to scoring or similarity.

This note consolidates what I have found across several research passes, with the
source URLs cited inline so a later pass can re-check anything that matters.

## 1. Data already in the build

- ACS 5-year base, via the census plugin (keyless where possible, Census API key where needed)
- Geography plugin (state name, etc.)
- NCES EDGE district staffing/enrollment and NYC DOE named-school detail
- CDC PLACES (already referenced in attribution)
- Map stack: hexbin + centroids + projection + scale + binning
- Composite scoring, affordability path, similarity set + default weights + cutoff
- Saved searches, CSV export, URL state, guided tour, key prompt, figure filters

### NYC DOE 2020 High School Directory: terms, attribution, and freshness (reviewed 2026-10-16)

- **Source and scope:** [2020 DOE High School Directory](https://data.cityofnewyork.us/Education/2020-DOE-High-School-Directory/23z9-6uk9), Socrata ID `23z9-6uk9`, currently read from the [official resource API](https://data.cityofnewyork.us/resource/23z9-6uk9.json). The directory is NYC-specific, not a nationwide school source.
- **Dataset metadata is distinct from portal policy:** the live [dataset metadata](https://data.cityofnewyork.us/api/views/23z9-6uk9.json) identifies `Department of Education (DOE)` as the attribution, but `license.licenseId`, `license.name`, and `license.url` are null. The dataset has no named license identifier in its metadata. Do not describe it as carrying a particular named license or public-domain dedication.
- **Portal-wide reuse policy:** NYC Open Data's [official FAQ](https://www.nyc.gov/opendata/get-started/FAQs) says there are no restrictions on use of Open Data. The City's [Technical Standards Manual, §2.3.2](https://opendata.cityofnewyork.us/wp-content/uploads/NYC_OpenData_TechnicalStandardsManual.pdf) says published datasets are public resources available to anyone without restriction or licensing requirements. The [portal Terms of Use](https://data.cityofnewyork.us/stories/s/Terms-of-Use/k9k7-3cje) also apply NYC.gov terms and allow additional terms defined by the data provider; no separate DOE terms were identified in this dataset's metadata. The official [metadata and citation guidance](https://cityofnewyork.github.io/opendatatsm/citystandards.html) says NYC datasets should be attributed to the City and that an agency's preferred citation should be in dataset metadata or supporting documentation. The City's [public-policy guidance](https://cityofnewyork.github.io/opendatatsm/publicpolicies.html) notes that the City may require a public republisher or application to identify source, version, and modifications. This supports the existing live application use under portal policy, without turning the blank metadata field into a named dataset license.
- **Attribution implication:** retain a visible citation naming NYC DOE, the `2020 DOE High School Directory`, its 2018–19 school-year vintage, and NYC Open Data. This identifies the source and version in line with City guidance. Do not remove the attribution because the portal policy permits use.
- **Freshness implication:** the source is titled “2020,” while the integration records its data vintage as `2018-19 school year`; the live metadata's `rowsUpdatedAt` timestamp is 2019-10-23 and supplies no update-frequency custom fields. The Terms of Use say the submitting agency is authoritative, data may be updated/corrected/overwritten/refreshed at any time, and older versions are not retained. Treat the directory as historical school-year information, never imply it is a current directory, and retain the vintage in the UI and exports. The City's terms state no cache TTL, but CivicScope's 30-day response cache can lag a portal update by up to its TTL.
- **Architecture disposition:** this research closes the source-terms question for the existing browser-side API use. Keep the established browser-only path and no-bundled-data decision. The City policy permits application use; the app's no-bundled-data rule remains a separate product/architecture constraint. Do not add a Worker, redistribute a bundled copy, or change scoring as a result of this research.

### EPA National Walkability Index: browser context lane (reviewed 2026-10-16)

- **Official source and meaning:** EPA's [Smart Location Mapping page](https://www.epa.gov/smartgrowth/smart-location-mapping) describes SLD v3 as a nationwide block-group dataset with more than 90 indicators, updated in 2021. EPA says its ArcGIS/Ogc web services are available for public use in web mapping applications. The [SLD v3 Technical Documentation and User Guide](https://nepis.epa.gov/Exe/ZyPURL.cgi?Dockey=P1014W9I.TXT) defines the fields below and documents their historical source vintages and limitations. The [Data.gov SLD record](https://catalog.data.gov/dataset/smart-location-database) lists CC0 1.0, but its catalog `Dataset Last Updated` date remains 2013 even though EPA identifies the current SLD release as 2021. The app keeps EPA attribution as provenance; this research does not make a separate legal determination about the stale catalog metadata.
- **Geography and vintage:** SLD v3 uses 2018 TIGER/Line polygons and exposes updated 2019 block-group FIPS identifiers in `GEOID20` alongside legacy 2010 identifiers; EPA says 74 block-group identifiers changed. Spatially derived measures including D4A use the 2010 population-weighted block-group centroids. The bundle of measures is historical, not a live update of local conditions. Field inputs are: `D1A`, 2018 ACS five-year housing units and unprotected-land acreage; `D2B_E5MIXA`, 2017 Census LEHD Workplace Area Characteristics; `D3B`, 2018 HERE Maps NAVSTREETS; `D4A`, 2020 GTFS and 2020 CTOD transit-stop inputs plus the older centroid; and `D5AR`, 2020 TravelTime routing and 2017 LEHD jobs. `NatWalkInd` is an index calculated from selected ranked SLD fields. Keep both the 2021 release and these field-specific input vintages visible.
- **Implemented scope:** the existing point-context request returns six named measures in one query: `NatWalkInd` (EPA's nationally relative 1–20 index); `D1A` (gross housing-unit density per acre of land EPA identifies as unprotected); `D2B_E5MIXA` (employment entropy normalized over a fixed set of five job categories); `D3B` (weighted street-intersection density per square mile); `D4A` (minimum walk-network distance in meters from the historical 2010 population-weighted centroid to a transit stop); and `D5AR` (time-decay-weighted jobs for a modeled 45-minute auto trip from the residential block group). D5AR uses 2020 TravelTime routing and 2017 Census LEHD jobs, with EPA's documented 8 a.m. typical non-holiday Tuesday assumption. `D4A` uses 2020 GTFS and CTOD stop data; its 0.75-mile straight-line candidate-search threshold and GTFS coverage limit availability. Its `-99999` sentinel indicates a distance-threshold or required-coverage failure, and it is not current service frequency or travel time. SLD indicators describe block groups, not ZIP-wide averages. D3B does not measure sidewalk presence or quality; the NWI is a composite indicator, not an on-the-ground walking or safety inspection.
- **Access path and freshness:** the selected ZIP's Census-geocoded point is sent directly from the visitor's browser to EPA's [SLD layer 1 query service](https://geodata.epa.gov/arcgis/rest/services/OA/SmartLocationDatabase/MapServer/1/query), with only `GEOID20` and the six fields above requested. Exactly one valid containing block group is required; missing, malformed, or boundary-ambiguous responses are suppressed. No key, Worker, server-side copy, or bundled EPA source data is used. The standard local response cache is 30 days, so upstream corrections can take up to that window to appear after an earlier lookup.
- **Sentinels and context boundary:** the parser treats EPA's `-99999` D4A transit-distance sentinel and `99999` no-land/no-population/no-jobs accessibility sentinel as not applicable, preserves legitimate zeroes, and rejects values outside the documented indicator ranges. All six measures stay in the keyless context lane. The existing comparison matrix includes a measure only when the same publisher, field, and vintage are present for every selected area; EPA values remain outside sorting, similarity, and composite scores.
- **Exercised behavior:** the running local browser preview queried ZIP `94103` and returned `GEOID20` `060750178022` with all six SLD fields. Its source details name the specific table field, 2021 release, containing-block-group geography, and point-not-ZIP caveat. The focused parser/formatting/sorting-boundary cases are in `tests/epa-nwi.test.ts`; the exact live-browser result and full verification commands are recorded in `docs/canon-work-mission.md`.
- **Scope disposition:** Rank 3's outcome is the six-measure context lane above. EPA's other 90-plus SLD attributes and separate transit-access tool are outside this outcome, not unfinished work. Reopening that broader catalog requires a separate user job, source-vintage, geography, and presentation decision; none of the six current measures may become a neighborhood grade or a scoring/similarity input.

### HUD Fair Market Rent / Small Area FMR: access and geography blocker (reviewed 2026-10-16)

- **Access and terms:** HUD's [FMR API documentation](https://www.huduser.gov/portal/dataset/fmr-api.html) requires a HUD User account, registration for the FMR dataset API, token creation, and an `Authorization: Bearer` header. It documents 401 for authentication failure and 403 when the account is not registered for that dataset. The [HUD User API terms](https://www.huduser.gov/portal/dataset/api-terms-of-service.html) permit applications that search, display, analyze, retrieve, or view API content, require this prominent notice: “This product uses the HUD User Data API but is not endorsed or certified by HUD User,” and limit access to 60 queries per minute.
- **Browser check from the app origin:** on 2026-10-16, Chromium at `http://127.0.0.1:5173` fetched `GET https://www.huduser.gov/hudapi/public/fmr/data/METRO47900M47900?year=2027` with a deliberately invalid placeholder bearer value. The browser could read the response as CORS (`401`, `{"error":"Unauthenticated"}`); the response exposed `Access-Control-Allow-Origin: *` and allowed the `Authorization` header. This verifies the API's cross-origin path, but not a successful authenticated request: no HUD account/token is available in this checkout or preview. The official FY2027 lookup page loads as a top-level page, but app-origin fetches to its `filter/year` and `filter/hmfa` endpoints and to the FY2027 SAFMR XLSX returned `202 Accepted`, empty `text/html`, and `x-amzn-waf-action: challenge`. Those routes are not a usable anonymous cross-origin fallback from the current browser surface.
- **Geography join:** the API's `fmr/data/{entityid}` accepts a county FIPS or metro-area identifier, not a ZIP query parameter. HUD documents metro-area SAFMR responses as a `basicdata` array with five-digit `zip_code` rows and bedroom rents, including an `MSA level` row. The [SAFMR page](https://www.huduser.gov/portal/datasets/fmr/smallarea/index.html) defines these as ZIP Codes and says they are mandatory only in HUD-designated areas (other agencies may opt in). CivicScope resolves a Census ZCTA point; its location record has no HUD FMR-area identifier or authoritative ZCTA-to-HUD-ZIP crosswalk. The existing county/tract enrichment does not prove which HUD metro/HMFA ID owns that ZIP, especially where HUD defines subareas. Equality between a ZCTA identifier and HUD's ZIP field is not a verified join.
- **Vintage and meaning:** HUD's [FMR data page](https://www.huduser.gov/portal/datasets/fmr.html) now publishes FY2027 county and SAFMR schedules (the SAFMR XLSX is 4,286 KB). HUD says FMRs generally take effect at the start of the federal fiscal year, usually October 1, and publishes an exception list for areas where FY2026 FMRs remain effective. The API's `year` parameter is optional and defaults to the latest year, so a future query must pin and display a fiscal year; no authenticated FY2027 API response was verified here. FMR is a housing-assistance program benchmark, not an ACS median gross-rent estimate or an asking rent.
- **Disposition:** keep Rank 4 open. A browser-authenticated API call may fit the no-Worker/no-bundled-data architecture if the visitor supplies a HUD token, but the authorized response and the required ZCTA-to-HUD-area/ZIP join are not verified. The public lookup and workbook are not browser-fetch fallbacks from the app origin. Do not ship partial or county/metro-substituted values as ZIP SAFMRs. If revisited, require a verified join, a user-held token path, explicit FY/area labels, the HUD notice, and a clear distinction from ACS rent.

### FCC Broadband Data Collection: access and geography blocker (reviewed 2026-10-16)

- **Official access and product shape:** the FCC [account instructions](https://help.bdc.fcc.gov/hc/en-us/articles/20044640394395-How-to-Create-an-FCC-User-Account) say an FCC user account enables use of the Public Data API, and the [key reference page](https://help.bdc.fcc.gov/hc/en-us/articles/6789299021723-Key-Reference-Documents) links the API specification. The FCC [mobile-data guide](https://help.bdc.fcc.gov/hc/en-us/articles/43909220634651-How-to-Download-Mobile-Broadband-Coverage-Data-from-the-FCC-s-National-Broadband-Map-Step-by-Step-Instructions) describes programmatic API downloads and selecting a specific “Availability Data As Of” date. The [map guide](https://help.bdc.fcc.gov/hc/en-us/articles/10467446103579-How-to-Use-the-FCC-s-National-Broadband-Map) describes fixed availability as CSV and mobile coverage as GIS, with provider-, area-, and nationwide downloads. Its listed summary geographies are state, county, CBSA, place, congressional district, and Tribal area; ZIP/ZCTA is not listed. The official API-spec PDF URL linked from the account guide returned HTTP 403 during this review, so its full request contract could not be inspected.
- **App-origin browser probe:** on 2026-10-16, Chromium at `http://127.0.0.1:5173` attempted `GET` to the [FCC Public Data API listing route](https://broadbandmap.fcc.gov/api/public/map/listAsOfDates). A browser fetch from the app origin failed with `TypeError: Failed to fetch`; Chromium reported that the response had no `Access-Control-Allow-Origin`. Adding placeholder `username` and `hash_value` headers caused the preflight to fail for the same missing CORS header. No real credentials were used. For comparison, a direct Node GET without an `Origin` header returned HTTP 401 JSON (`Unauthorized`); a direct request with the CivicScope `Origin` returned HTTP 403 HTML without CORS headers. These results verify no usable browser path from this origin, not the authenticated API response. The tested FCC API route and the official account instructions also establish that this is not a keyless query path.
- **Geography and join:** FCC help says fixed providers report availability at the map's [individual location points](https://help.bdc.fcc.gov/hc/en-us/articles/13532984820379-What's-on-the-National-Broadband-Map). The FCC says download records are keyed by Location ID, while extra address, coordinate, and building details require Fabric access ([Fabric access rules](https://help.bdc.fcc.gov/hc/en-us/articles/10419121200923-How-Entities-Can-Access-the-Location-Fabric)). CivicScope's selected-area location is a Census ZCTA point, and neither the documented area summaries nor the current location record provide a verified FCC Location ID or ZCTA-to-FCC geography join. A point record cannot be converted into a ZCTA estimate without a documented crosswalk or appropriate location geometry.
- **Vintage, meaning, and terms:** the FCC says providers file availability twice a year ([map data overview](https://help.bdc.fcc.gov/hc/en-us/articles/13532984820379-What's-on-the-National-Broadband-Map)), and the map's download workflow pins an “as of” date; the file's later “last updated” date can differ from that as-of vintage. No authenticated listing or download succeeded here, so the current selected vintage and its fit beside the ACS no-internet-subscription estimate remain unverified. The FCC [Fabric access rules](https://help.bdc.fcc.gov/hc/en-us/articles/10419121200923-How-Entities-Can-Access-the-Location-Fabric) require a separate limited license: the Standard Agreement is for generating BDC challenge/crowdsource data, while the Tier 4 Research License is for non-commercial academic or public-policy research directly related to broadband availability. This review did not establish that CivicScope's planned use qualifies for a Fabric license, nor verify reuse/redistribution terms for a Fabric-based ZIP join. Do not infer those rights from the public map's downloadable availability data.
- **Disposition:** keep Rank 6 open. Blockers are a failed app-origin CORS path, account-gated API access with no authenticated result, no verified ZIP/ZCTA join, no pinned current vintage, and uncleared Fabric/reuse terms. The available fixed CSV/mobile GIS downloads remain bulk file products; do not bundle them or substitute county/metro summaries for ZIP context. FCC availability is not internet performance, price, or household adoption, and must not be equated with the ACS measure.

### Nationwide named-school performance sources (reviewed 2026-10-16)

- **Outcome source and observed vintage:** the official [ED Data Express filtered download tool](https://eddataexpress.ed.gov/download/data-builder/data-download-tool?f%5B0%5D=level%3ASchool&f%5B1%5D=all_students%3AAll+Students+in+School&f%5B2%5D=file_spec%3A150&f%5B3%5D=school_year%3A2022-2023) returned 23,912 rows for 2022–23 school-level EDFacts FS150 (ACGR); this is a row count, not a unique-school count. The rendered table includes `NCES SCH ID`, school, value, denominator, population and subgroup. An observed Alabama row was Albertville High School, `010000500871`, with ACGR shown as 92% and denominator 410. Other values are binned (for example, `90-94%` and `>=95%`) or suppressed (`S`), so any future display must preserve those forms rather than treat them as exact rates. The [CEDS FS150 connection](https://ceds.ed.gov/connectReport.aspx?uid=153) describes SEA-, LEA- and school-level reporting, requires State LEA Identifier and State School Identifier in the underlying submission, and limits school reporting to entities with operational grade 12. ED Data Express exposes an `NCES SCH ID` in its rendered table, which enabled the verified join below; a raw FS150 file join would also need an official identifier crosswalk. This is not an all-grade school-quality measure. The 2023–24 filter option was visible, but a corresponding school-level result was not verified in this pass; record 2022–23 as the latest vintage actually verified, not as a proven latest national release.
- **Location and join:** the official [NCES EDGE public-school locations service](https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2223/MapServer/0/query?where=NCESSCH%3D%27010000500871%27&outFields=NCESSCH%2CNAME%2CZIP%2CLAT%2CLON%2CSCHOOLYEAR&returnGeometry=false&f=pjson) exposes `NCESSCH`, name, ZIP, latitude, longitude and school year in a browser-queryable REST layer. A same-vintage query for `010000500871` returned Albertville High School in ZIP 35950 at 34.2622, -86.2049, year 2022–23. This verifies that ED Data Express's displayed NCES school key can join to an official NCES EDGE public-school location row. Coverage is public schools, and the source IDs/vintages must remain aligned. NCES's [Common Core of Data overview](https://nces.ed.gov/ccd/pubschuniv.asp) and [school location information](https://nces.ed.gov/programs/edge/Geographic/SchoolLocations) provide the broader source context. The previous [55-candidate portal-catalog probe](../tools/probe-school-sources.mjs) found no single portal candidate meeting the name/coordinate/outcome criteria; it did not cover this federal two-source join.
- **Browser and architecture check:** the ED Data Express page rendered as a top-level browser page and offered filtered CSV download; its [download-tool guide](https://eddataexpress.ed.gov/sites/default/files/resource_data_files/data_download_tool_user_guide_0_0.pdf) documents that workflow. From CivicScope's local app origin, a browser `fetch` of the same filtered page returned HTTP 202 with an empty HTML body; adding credentials failed CORS. No official per-school-ID query endpoint or direct per-ZIP API was identified. Thus the source pair is joinable as data, but not currently consumable as the planned live browser-only ZIP lookup. Bundling annual files would violate the no-bundled-data constraint; adding user CSV import or a server/proxy would expand the current product architecture.
- **Disposition (as of 2026-10-16):** ED Data Express remains a batch research lead, not an app integration. A different browser-readable Portal API path was verified the following day and is documented below. Do not describe NCES enrollment/location as performance.

### CRDC school-level measures: official profile API is not cross-origin readable (reviewed 2026-10-16)

- **Coverage and vintage:** the U.S. Department of Education says its 2021–22 Civil Rights Data Collection (CRDC) collected data from virtually every public school and links a tool for school-, district-, state-, and national-level reports ([2021–22 overview](https://www.ed.gov/laws-and-policy/civil-rights-laws/civil-rights-data-collection-crdc/civil-rights-data/civil-rights-data-collection-crdc-2021-22-school-year)). The current [OCR download page](https://ocrdata.ed.gov/data) lists public-use files for 2023–24 and 2021–22; the Department's [CRDC data page](https://www.ed.gov/laws-and-policy/civil-rights-laws/civil-rights-data-collection-crdc/civil-rights-data) describes the 2023–24 and 2021–22 collections as covering public schools and districts receiving federal assistance. The first-party `SurveyYearsList` maps API key `12` to 2023–24 and key `11` to 2021–22. CRDC measures student enrollment, educational-program access, courses, and school-climate/civil-rights factors. This is useful school-level opportunity context, not an ACGR or a general academic-achievement score; it should not be labeled school quality.
- **NCES join and first-party API:** in the official CRDC page's browser context, the [survey-year endpoint](https://ocrdata.ed.gov/api/v1.0/SurveyYearsList?cutoff=10) maps API key `12` to 2023–24 and `11` to 2021–22. The [sample school query](https://ocrdata.ed.gov/api/v1.0/SchoolSearch?long_Nces_Id=010000500871&survey_Year_Key=11) and the same query with key `12` each returned Albertville High School, NCES ID `010000500871`, and CRDC `school_Id` `273110`. The 2023–24 record also reports grade span 9–12 and enrollment fields. The school-level `EntityMeasures` request returned HTTP 200 JSON. The inspected JSON endpoints returned `application/json; charset=utf-8` and no `Access-Control-Allow-Origin` header. The CRDC profile page and its [official data interface](https://ocrdata.ed.gov/view) therefore demonstrate a usable school-ID join within the publisher's own app, but not a documented external API contract.
- **CivicScope-origin test:** from the running local origin `http://127.0.0.1:5173`, browser `fetch` with `mode: "cors"` and `credentials: "omit"` to `SurveyYearsList`, `SchoolSearch`, `GetSchoolProfile`, `EntityMeasures`, and `GetEnrollmentData` failed with `TypeError: Failed to fetch` for tested 2021–22 and 2023–24 queries. The same five API routes for 2023–24 and `HEAD` requests to both official CRDC ZIP downloads also failed from the published CivicScope origin `https://civicscope.pages.dev` (the app page itself returned HTTP 200). From the official page origin the API returned HTTP 200 JSON, but with no CORS allow-origin header. The official [2023–24 ZIP](https://ocrdata.ed.gov/assets/ocr/docs/2023-24-crdc-data.zip) returned HTTP 200 with `Content-Length: 99570187` (99,570,187 bytes, about 99.6 MB). Thus neither the internal profile API nor the bulk file supplies the planned direct browser path; bundling the annual file violates the no-bundled-data constraint, while a proxy or CSV-import flow changes the architecture.
- **Disposition:** CRDC remains research-only. Its first-party API is not cross-origin readable in the tested browser, and its measures are not a substitute for academic outcomes. The school coverage item is now partially addressed by the separate EDFacts API path below; no CRDC code or bundled data was added.

### Browser-readable nationwide school outcomes (reviewed 2026-10-17)

- **Outcome source:** the official [Urban Institute Education Data Portal API documentation](https://educationdata.urban.org/documentation/index.html) specifies direct JSON endpoints with query filters. Its [school data documentation](https://educationdata.urban.org/documentation/schools.html) describes EDFacts adjusted cohort graduation rates as school-level, four-year outcomes reported by race and special populations, with values published as ranges that narrow as cohort sizes grow. The integration uses the API's 2019 endpoint and selects the total (`99`) for race, disability, economic-disadvantage, foster-care, homelessness, and limited-English-proficiency filters. The 2019 vintage is the one implemented; CivicScope does not claim it is the latest available release.
- **Observed API behavior:** a live Chromium request from a loopback web origin returned HTTP 200 with `response.type === "cors"`; statewide queries for Alabama and California returned 378 and 2,529 records respectively, each with `next: null` in the observed response. Some rows contain low/high bands (for example, 90–94 with midpoint 92); other rows have no low/high bounds. The app displays the Portal midpoint as a midpoint and includes a row's band in detail. Missing, not-applicable, suppressed, and out-of-range values are omitted.
- **School locations and join:** the official [NCES EDGE public-school locations service](https://nces.ed.gov/opengis/rest/services/K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_1920/MapServer/0) provides the 2019–20 public-school `NCESSCH`, name, state FIPS, and coordinates. A bounded location query returns schools within 3 km of the selected point; outcomes are requested once for each nearby state and joined by NCES school ID after normalizing leading zeroes in the Portal response. The result list is limited to the eight nearest schools with a reportable ACGR. The source is public schools, not private schools.
- **Attribution and terms:** the Portal states that its datasets are made available under the [Open Data Commons Attribution License (ODC-By) 1.0](https://opendatacommons.org/licenses/by/1-0/), and requests that citations name both the dataset and the Education Data Portal. The app attributes U.S. Department of Education EDFacts, the Urban Institute Portal, and NCES EDGE, and identifies the Portal license. This source review is product research, not legal advice or attorney review.
- **Product boundary and remaining limits:** at most eight nearest 2019 four-year adjusted cohort graduation outcomes from public schools with reportable values are displayed. A school must fall within 3 km of the selected point; missing, not-applicable, or suppressed records do not appear. The source is not an all-grade achievement measure, current-year directory, complete list of nearby schools, or school-quality rating. NYC DOE's 2018–19 enrollment, graduation, and attendance detail remains active as a separate local source. The change adds no backend, Census key requirement, or bundled data.
- **Disposition:** `CIVICSCOPE-R2-SCHOOLS` is **partially addressed**. A direct, source-attributed nationwide lane is implemented for the outcome above; broader years, grades, school types, and outcome measures remain uncovered. The deterministic unit and production-browser tests stub NCES and Portal responses.

### Census-key browser verification

The Census Bureau's current [API key guidance](https://www.census.gov/data/developers/guidance/microdata-api-user-guide/api-key.html) requires a key for Census Data API queries; the [key form](https://api.census.gov/data/key_signup.html) issues one free of charge. The product keeps the key in the browser. Local saved-key loading and its exact verification scope are recorded in the [canonical backlog](canon-work-mission.md#L303).

## 2. What real users actually want (use-case lens)

See [use-case-data-map.md](use-case-data-map.md) for the full use-case → source → function map. The short version:

- Short-list comparison users want trust and explanation first — currentness, provenance, and a score they can read.
- Similarity users want the levers exposed and the match explained.
- Returning renters want persistence and a real export.
- Curious-locals want correct place labels, clean geocoding, and honest framing.
- Power users want filter semantics, round-tripping, and complete exports.
- First-time visitors want an honest key prompt and a useful keyless path.
- Citation/advocacy users want methodology, attribution, and a defensible "what we do not have" list.

The household-count consistency issue identified in the earlier plan is now corrected in
the ACS plugin and methodology table. The current backlog records its tests and verification
status.

## 3. Enrichment candidates, with verdicts

### Tier A — Strong, low-risk, and either already free/downloadable or plausibly buildable

These are the ones worth treating as real future work rather than as a wish list.

- **EPA Smart Location Database (SLD) + National Walkability Index**
  - Free, nationwide, block-group level.
  - SLD is a 90+ indicator built-environment/transport/demographic dataset; the Walkability Index ranks block groups nationally.
  - Data.gov metadata lists CC0 / public; EPA still frames these as public resources.
  - Verdict: best free walkability/built-environment baseline. Strong fit for a "what is this neighborhood like" layer.
  - Caveat: EPA frames SLD's current version as a 2021 update, and the Walkability Index as a relative ranking, not a sidewalk/crossing inspection. Keep that framing in the UI.

- **EPA Access to Jobs and Workers Via Transit**
  - Free, block-group level, where covered.
  - Measures jobs/workers reachable within a 45-minute transit + walking commute.
  - Coverage is metro/agency-dependent, not national.
  - Verdict: excellent transit-access signal where it exists; good complement to EPA walkability. Do not present as national.

- **HUD Fair Market Rents + Small Area FMRs**
  - FMR is metro/county; SAFMR is ZIP-level within HUD-designated areas, with optional use elsewhere.
  - HUD User API requires a registered account and token; its metro response can include ZIP rows, but the API takes an area ID rather than a ZIP. Browser CORS is verified; the app's ZCTA-to-HUD-area/ZIP join is not.
  - Verdict: a potentially useful program benchmark alongside ACS rent, but Rank 4 stays open until a user-held token path and exact geography join are verified. Do not present county/metro FMR as ZIP SAFMR.

- **HUD Income Limits**
  - Metro/county geography; same token-protected HUD User API.
  - Verdict: useful "what counts as low/moderate income here" context. Same credential caveats as FMR.

- **HUD Location Affordability Index (LAI)**
  - Nationwide tract-level modeled housing + transport cost index.
  - Current version is v3 (March 2019), built from 2012–2016 ACS.
  - Available via HUD eGIS downloads/data services; Data.gov lists it as public.
  - Verdict: useful framed benchmark if we label the vintage honestly. Do not present as current-year cost.

- **Census CBP / ZIP Code Business Patterns (ZBP)**
  - Free via Census API with a key; downloadable too.
  - Business establishments, employment, payroll by geography; includes ZIP-level business geography.
  - Verdict: useful economic-activity context. Not residential employment and not household economics, so frame it as business context, not as a jobs/livelihood figure.

- **Census Population Estimates Program (PEP)**
  - Free via Census API with a key; downloadable too.
  - Annual population estimates by state/county/city/town; not ZIP-level directly.
  - Verdict: useful population trend context at the county/city level. Use ZCTAs carefully and do not assume PEP gives ZIP population directly.

- **FCC National Broadband Map / Broadband Data Collection (BDC)**
  - Public map and fixed CSV/mobile GIS downloads; an account enables the Public Data API, whose documented role here is programmatic BDC file downloads.
  - Fixed availability is reported at FCC Fabric location points; FCC's documented area summaries do not include ZIP/ZCTA. App-origin Chromium requests to the FCC listing route failed CORS, and no authenticated response was verified.
  - Verdict: relevant connectivity context, but not an available CivicScope ZIP lane. Keep deferred until account/API access, CORS, a source-supported ZIP join, a pinned vintage, and data/Fabric use terms are verified. Do not assume Fabric-level attributes are free to reuse.

### Tier B — Useful, but heavier, narrower, or more specialized

These are genuine sources, but the cost/architecture/discipline is higher.

- **LEHD / LODES (OnTheMap)**
  - Origin-destination job counts at census-block detail; public-use LODES files are the main access route rather than a general API.
  - Verdict: best commute/jobs-access signal if we ever build a build-time spatial pipeline. Powerful but bulk-file and geography-heavy. Not a first-pass browser feature.

- **HMDA mortgage lending data**
  - Public, privacy-modified, tract-level lending detail.
  - Verdict: rich but lending-specific and heavy. Good advanced-analytics enrichment, not first-pass.

- **SAIPE**
  - County/school-district modeled poverty and median income; annual.
  - Verdict: useful county context, but ACS already covers much of this at better geography. Mostly redundant for this tool.

- **CDC/ATSDR Social Vulnerability Index (SVI)**
  - Tract and county; latest verified release is 2022 (ZCTA only in 2022).
  - Verdict: useful community-vulnerability context at tract/county. Keep vintages and do not imply comparability across years.

- **FEMA National Risk Index (NRI)**
  - County and tract; covers 18 hazards; current release is December 2025, v1.20.
  - Verdict: strong hazard context layer. Frame as area context, not insurance/parcel advice. Respect OpenFEMA reuse terms, including the prohibition on using the data to decide individual rights/benefits.

- **USGS seismic hazard + NOAA climate/storm data**
  - USGS 2023 National Seismic Hazard Model is CC0; NOAA CDO and Storm Events are free but CDO API needs a token and has rate limits.
  - Verdict: useful deeper hazard/environment features: modeled seismic hazard, historical storm events, climate observations. NOAA historical events are not a forward-looking hazard rating.

- **EPA TRI / Superfund / SEMS / impaired waters**
  - Free, facility or site/assessment-unit level.
  - Verdict: useful environmental-proximity context with proper framing. TRI records releases, not exposure; impaired-water status is a waterbody assessment, not tap-water quality.

- **CEJST / EJScreen**
  - CEJST v2 was December 2024; EJScreen last verified was v2.3, 2024.
  - Important caveat from research: public access to the federal EJScreen tool was discontinued 2025-02-05, and public access to the White House CEJST tool ended 2025-01-22. Independent reconstructions/archives exist, but they are not the live federal tools.
  - Verdict: useful historical/archived EJ context if we want it, but label version and vintage prominently and do not present as current federal screening tools.

### Tier C — Convenient but not first-pass for this architecture

These are real services, but they are proprietary, priced, key-/branding-bound, or otherwise awkward for an open, client-side-first tool.

- **Walk Score / Transit Score / Bike Score**
  - Proprietary API, free tier plus paid plans, branding/API-key terms.
  - Verdict: simple point scores, but not an open bulk dataset and not a free general license for offline or high-volume reuse.

- **TomTom / INRIX traffic data**
  - Commercial traffic/congestion data; INRIX terms were not verifiable from primary pages in the research pass.
  - Verdict: traffic congestion is a separate modeling problem with commercial data behind it. Not a free open dataset.

- **SIPP / Credit-panel microdata**
  - Not geography-ready for this product.
  - Verdict: not for this tool.

## 4. Architecture notes that affect which sources are realistic

- The default runtime is browser-only, and Phase 1 rules out bundled source figures. That favors:
  - direct browser requests to public publisher services when the source supports them
  - browser-local response caching, with source vintage and cache age stated
  - API-key sources only through the existing key/credential discipline; do not add a Worker or copy source data to avoid a key wall

- The strongest current architecture fit is:
  - EPA SLD and National Walkability Index measures through the live browser query for one selected point; do not turn the bulk SLD into a bundled block-group or ZIP layer
  - HUD FMR/SAFMR only as a token-gated, user-supplied-key path after a verified ZCTA-to-HUD-area/ZIP join; the API's CORS path is browser-readable, so no Worker is needed for that route
  - LAI as a clearly-labeled vintage benchmark, not a live cost model
  - FCC BDC only after a successful browser-origin query, a source-supported ZIP join, a pinned as-of vintage, and a terms review; bulk downloads and the separately licensed Fabric do not fit the current lane
  - NRI and CDC context layers as area context, not property-level determination

- The most dangerous additions are the ones that amplify steering risk:
  - crime data (easy to misuse as a race proxy)
  - anything that becomes a "best area" inference
  - any layer presented without a clear "context only" lane

## 5. Coherence rule before adding anything

A new source is only "stronger" if it lands in all the places a user-facing feature needs it:

- figure cards, where relevant
- a clearly labeled "context only" lane where relevant
- similarity, only if it is a trait a buyer/renter would reasonably weight
- export columns, if the user can see it
- methodology, with geography, vintage, provenance, and framing
- accessibility and completion-gate checks

If a source can only live in one of those, it is not yet a cohesive feature — it is
a research note.

## 6. Source URLs I want to keep handy

- EPA Smart Location Mapping: https://www.epa.gov/smartgrowth/smart-location-mapping
- EPA National Walkability Index: https://www.epa.gov/smartgrowth/national-walkability-index-user-guide-and-methodology
- Data.gov Smart Location Database record: https://catalog.data.gov/dataset/smart-location-database
- EPA Access to Jobs and Workers Via Transit: same EPA Smart Location Mapping page
- HUD Location Affordability Index: https://www.hudexchange.info/programs/location-affordability-index/
- HUD LAI v3 announcement: https://www.huduser.gov/portal/elist/2019-may_23.html
- Data.gov LAI v3 record: https://catalog.data.gov/dataset/location-affordability-index-v-3
- HUD FMR and Income Limits API docs: https://www.huduser.gov/portal/dataset/fmr-api.html
- HUD FMR data: https://www.huduser.gov/portal/datasets/fmr.html
- HUD Small Area FMRs: https://www.huduser.gov/portal/datasets/fmr/smallarea/index.html
- HUD Income Limits: https://www.huduser.gov/portal/datasets/il.html
- HUD API terms: https://www.huduser.gov/portal/dataset/api-terms-of-service.html
- GTFS data-sharing resources: https://gtfs.org/resources/sharing-data/
- Mobility Database FAQ: https://mobilitydatabase.org/faq
- OSM copyright/license: https://www.openstreetmap.org/copyright
- FCC BDC key reference documents: https://help.bdc.fcc.gov/hc/en-us/articles/6789299021723-Key-Reference-Documents
- FCC mobile broadband download guide: https://help.bdc.fcc.gov/hc/en-us/articles/43909220634651-How-to-Download-Mobile-Broadband-Coverage-Data-from-the-FCC-s-National-Broadband-Map-Step-by-Step-Instructions
- FCC Location Fabric access: https://help.bdc.fcc.gov/hc/en-us/articles/10419121200923-How-Entities-Can-Access-the-Location-Fabric
- FEMA NRI data: https://www.fema.gov/about/openfema/data-sets/national-risk-index-data
- FEMA NRI overview: https://www.fema.gov/flood-maps/products-tools/national-risk-index
- FEMA OpenFEMA API docs: https://www.fema.gov/about/openfema/api
- FEMA OpenFEMA terms: https://www.fema.gov/about/openfema/terms-conditions
- CDC/ATSDR SVI downloads and docs: https://www.atsdr.cdc.gov/place-health/php/svi/svi-data-documentation-download.html
- CDC PLACES data portal: https://www.cdc.gov/places/tools/data-portal.html
- CDC PLACES 2025 county dataset metadata: https://data.cdc.gov/api/views/swc5-untb.json
- EPA EJScreen historical download page: https://19january2021snapshot.epa.gov/ejscreen/download-ejscreen-data_.html
- Independent EJScreen status notice: https://screening-tools.com/epa-ejscreen
- Independent CEJST reconstruction: https://screening-tools.com/climate-economic-justice-screening-tool
- USGS 2023 50-state seismic hazard model: https://www.usgs.gov/programs/earthquake-hazards/science/2023-50-state-long-term-national-seismic-hazard-model-0
- USGS 2023 data release / CC0: https://www.usgs.gov/data/data-release-2023-us-50-state-national-seismic-hazard-model-overview
- NOAA CDO: https://www.ncei.noaa.gov/cdo-web/
- NOAA CDO API docs: https://www.ncei.noaa.gov/cdo-web/webservices/v2
- NOAA Storm Events bulk CSV index: https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/
- NWS API docs: https://www.weather.gov/documentation/services-web-api

## 7. What I did not verify and should not assert

- Whether HUD LAI has a definitive dataset reuse license beyond the Data.gov "public" marking.
- Whether FEMA NRI has a dedicated OpenFEMA API endpoint (downloads and an ArcGIS tract service were the confirmed access routes).
- Whether there is a supported dedicated CDC/ATSDR SVI API.
- The current INRIX commercial terms, because the primary product pages were not retrievable in the research pass.
- A current official EPA-hosted EJScreen or CEJST download/API as a maintained federal service.

This note is a working planning artifact, not a roadmap claim. Move anything into the
roadmap or audit only after the corresponding evidence exists.
