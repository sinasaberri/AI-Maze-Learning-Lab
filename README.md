# AI Maze Learning Lab

Train a tabular Q-learning agent in one of three mazes. Step through a decision, run at different playback speeds, inspect the Q-table and greedy policy, and chart the return from completed episodes. The Python trainer computes every transition and the React workspace renders the results.

## Local development

Install Python 3.12 and Node.js 22. From the repository root, create a virtual environment and activate it. Use `.venv\Scripts\Activate.ps1` in PowerShell or `source .venv/bin/activate` on macOS and Linux.

```sh
python -m venv .venv
```

After activation, install the dependencies and start FastAPI in the first terminal.

```sh
python -m pip install '.[dev]'
python -m uvicorn app:app --reload --ws websockets-sansio
```

In a second terminal, start Vite and open the URL it prints.

```sh
npm ci
npm run dev
```

Vite proxies `/api` to FastAPI, including WebSocket upgrades. For a production-style local run, stop the development servers, run `npm run build`, then start `python -m uvicorn app:app --ws websockets-sansio` and open `http://127.0.0.1:8000`.

```sh
npm run typecheck
npm run build
python -m pytest -q
```

## Deploy to Vercel

Import this Git repository into one Vercel project. Set the root directory to the repository root and use the **FastAPI** preset. Leave the Vercel Build Command and Output Directory overrides unset. The build command in `pyproject.toml` installs the locked npm dependencies and builds `dist/`. FastAPI registers the result with `app.frontend()`. Vercel promotes those files to its CDN and routes `/api` to the Python function. Both use the same public origin. There is no external backend or database.

`vercel.json` enables Fluid Compute for WebSockets and sets the function limit to 60 seconds within Hobby's documented 300-second limit. The WebSocket lease defaults to 55 seconds. Run these commands from the repository root with the virtual environment active. Create and verify a Preview before promoting to production.

```sh
npx vercel@65.16.0 login
npx vercel@65.16.0 link --project ai-maze-learning-lab
npm ci
npm run build
npx vercel@65.16.0 dev
npx vercel@65.16.0 deploy --yes --environment preview
```

On the Preview URL, open the workspace and check that `/api/health` returns `{"status":"ok","protocol":1}`. Click **Step** and verify the transition and TD values. Start training, pause, and confirm the step count stops. Resume and let a WebSocket lease expire, then verify the counter continues. Refresh and check that the Q-table and step count restore with training paused. After the Preview checks pass, deploy the same revision to production with `npx vercel@65.16.0 deploy --yes --prod` or merge to the Vercel project's production branch. Repeat the Preview checks on the production URL.

Sources for the deployment setup are [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi), [Vercel WebSockets](https://vercel.com/docs/functions/websockets), [Python runtime](https://vercel.com/docs/functions/runtimes/python), [function duration](https://vercel.com/docs/functions/configuring-functions/duration), and [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite).

### Environment variables

No application variables are required. See `.env.example` for the optional settings. Set `MAZE_DEV_API_TARGET` in Vite's `.env.local` only if the local API runs at a different address. Set `MAZE_WS_LEASE_SECONDS` in the Python process environment or Vercel project to test reconnection with a shorter lease. Values clamp to 1–55 seconds. For local Uvicorn, pass `--env-file .env.local` to load the Python setting from that file.

## Training protocol and recovery

`GET /api/experiments` provides the maze layouts and defaults. `POST /api/training/start` and `/api/training/reset` return a fresh snapshot for a supplied configuration. `POST /api/training/step` takes a snapshot and an optional count and returns new events and a replacement snapshot. API schemas are available at `/api/docs`.

1. The browser opens `/api/ws` and sends `{"type":"open","config":…,"snapshot":…}`. A fresh run sends `null` for its snapshot. FastAPI validates the checkpoint, starts a connection-scoped trainer and replies with `ready` and a snapshot.
2. The browser sends one `{"type":"advance","count":1}` request at a time. A response contains one to eight transitions and the resulting snapshot. A batch stops at an episode boundary or at the end of training. Each transition includes the state, action, reward, next state, old Q-value, TD target, TD error, new Q-value, episode and step, and exploration decision.
3. Pausing stops new requests and lets any in-flight batch finish. Resuming resumes requests. The connection ends at the lease boundary or goes to standby after 20 seconds of client inactivity. Starting or stepping from standby opens a new connection.
4. The browser checkpoints every accepted batch to IndexedDB. An unexpected disconnect retries at 500 ms, doubling up to 8 seconds. The next connection sends the last accepted checkpoint. If the connection dropped before the browser accepted a batch, the restored PCG64 random state lets the server replay it. The two 128-bit RNG values are stored as decimal strings to preserve precision in JavaScript.

The browser keeps one active experiment per origin and stores its configuration, state, full Q-table, counters, last 80 completed episodes, latest transition, trail and RNG state. Preview URLs, production, and localhost have independent checkpoints. Refresh restores the checkpoint with playback paused. Replacing an experiment or applying settings resets its checkpoint. If IndexedDB is unavailable, the current page can keep training and recover a connection using its in-memory snapshot.
