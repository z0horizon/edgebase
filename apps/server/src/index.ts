import { worker } from "@edgebase/core";

// The Durable Objects behind GET /v1/realtime (REALTIME) and its rooms (ROOMS); see wrangler.jsonc.
// Rooms stay off until you call configureRooms() here (see docs/extending.md).
export { RealtimeHub, RealtimeRoom } from "@edgebase/core";

// Add your own routes to `app` from "@edgebase/core" before this export; see docs/extending.md.
export default worker;
