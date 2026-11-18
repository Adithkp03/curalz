# Isolated street-map proxy

Review source only. Not deployed or operationally verified. No production mount.

- Set GEOAPIFY_MAPS_ENABLED=true and GEOAPIFY_API_KEY as a secret only on the isolated test host. Key must be current32hex value from the vault entry AlzheFi Geoapify isolated test API key. Never put key in client,source,logs,chat or artifact.
- POST /api/maps/:patientId supports only kind tile or search. Requires active primary caregiver link and patient location grant,checked again before results. Request consent=true is mandatory. No patient names,home label,location-feed data or live markers sent toprovider. Search text is explicitly submitted bycaregiver. Viewed tiles reveal the viewed area,including any selected saved-zone centre.
- Provider routes fixed to maps.geoapify.com/v1/tile/osm-carto/z/x/y.png and api.geoapify.com/v1/geocode/search. Redirects disabled. No provider URL or raw error sent toclient.
- Persisted UTC-day budgets: global8000quarter-creditunits =2000credits; peruser400units =100credits; each raster tile1unit,each search4units. PerUTCsecond global4requests. Atomic counters failclosed; rejected/concurrent/failed requests can still consume internal budget. This is a conservative app-side limit,not a provider billing guarantee or reservation of quota from otherproject use. Global1000credits/day remain outside this proxy budget onFree3000plan.
- No autoload/autocomplete/autorefresh. Each explicit preview loads4-9tiles sequentially with350ms gap. Manual search has5results maximum. Cancelling clears local map/search;already-in-flight request cannot be recalled. Consent scoped to opened editor,not permanent. Coordinates/radar fallback remain available.
- Required visual attribution: Powered by Geoapify and © OpenStreetMap contributors,linked to provider andOSMcopyright.
- Map data responses private/no-store. Mongo counters contain owner/day/count only,no query/coordinates. TTL cleanup. Vercel edge/provider may retain request metadata;do not promise zero logging.

Sources checked2026-11-18:
https://apidocs.geoapify.com/docs/maps/map-tiles/
https://apidocs.geoapify.com/docs/geocoding/forward-geocoding/
https://www.geoapify.com/pricing/
https://www.geoapify.com/privacy-policy/
