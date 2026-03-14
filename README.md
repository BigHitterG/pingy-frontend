# pingy-frontend
Pingy — community-approved coin spawning with balanced ownership at launch.

## Pump.fun backend adapter (local/dev)
A lightweight mocked backend adapter is now available under `server/`.

### Start backend
1. `cd server`
2. `npm install`
3. `npm start`

The backend listens on `http://localhost:8787` by default.

### Mocked endpoints
- `POST /api/pumpfun/launch`
  - Accepts launch JSON payload from frontend.
  - Validates `roomId`, `name`, `symbol`, `creatorWallet`.
  - Returns normalized launch submission shape (`ok`, `platform`, `status`, `url`, `mint`, `submitted_at`, `live_at`, `payload`).
- `POST /api/pumpfun/status`
  - Accepts status JSON payload from frontend.
  - Returns normalized status shape for polling/debug (`submitted` + distribution/settlement placeholders).
- `POST /api/pumpfun/settlement`
  - Accepts settlement JSON payload from frontend.
  - Validates `roomId`, `mint`, `recipientCount`, and `rows`.
  - Returns normalized settlement shape with mocked transaction IDs per row.

> Note: this phase intentionally keeps Pump.fun behavior mocked on the server side. Real Pump.fun integration is planned for a later phase.
