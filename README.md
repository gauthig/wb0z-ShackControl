# 📡 Ham Radio Web App — WB0Z Shack Control

A standalone **Node.js / Express** web application for controlling a ham radio
station from any browser on your local network. It replaces a Node-RED dashboard
and talks to the same equipment directly — **Node-RED does not need to be running**.

Designed to run on **Windows 11** on the same PC as your station software.

---

## Equipment supported

| Device | Interface | What you can do |
|---|---|---|
| **FlexRadio 8600** | UDP discovery (4992) + TCP | View 4 slices (freq/mode/active), 10 real-time meters (FWD power, SWR, PA volts/temp, fan RPM…), set RF power, toggle APD, link watchdog |
| **Palstar LA-1K Amp** | Serial (COM7, 9600 8N1) | Operate/Standby, antenna 1/2/3 select, FWD power, temperature, band & key status |
| **PST Rotator** | UDP (12000/12001, XML) | Live compass display, heading presets, manual azimuth, stop |
| **Palstar HF-Auto Tuner** | UDP (13080/12020, XML) | Antenna select, tuner mode (Bypass/Auto/Manual), SWR / TX watts / peak power, offline watchdog |
| **Home Assistant** | MQTT (192.168.1.54:1883) | Publishes station state; power smart-plug hooks |

---

## Features

- 🔐 **Authentication** with JWT tokens and **three roles**
  - **Admin** — full control **plus** user management & configuration
  - **Normal** — full device control, can change own password
  - **View-Only** — sees everything, cannot operate anything
- 👤 Pre-configured admin **`wb0z`** (change the password on first login!)
- 🔑 Every user can change their own password; admins can add users, set roles, reset passwords
- 📊 **Live dashboard** with status panels for every device
- 🎛️ Role-aware controls (buttons/sliders disabled for view-only users)
- 🎨 **Theme / color-palette customizer** with live preview (4 themes included, create your own)
- ⚡ **Real-time updates** over WebSocket — no page refresh needed
- 📱 **Responsive** layout for desktop and tablets
- 💾 Simple **JSON file storage** — no database to install
- 🧩 Carried-over **automation** rules from Node-RED (amp RF-power limiting, tuner antenna→mode rules, watchdogs)

---

## Quick start

```bat
cd C:\ham_radio_web_app
npm install
npm start
```

Then open **http://localhost:3000** and sign in:

| Username | Password |
|---|---|
| `wb0z` | `Jasonar-8806` |

> ⚠️ Change the admin password immediately from the **Change Password** button.

Full setup instructions: **[INSTALLATION.md](INSTALLATION.md)**
Every config setting explained: **[CONFIGURATION.md](CONFIGURATION.md)**

---

## Project structure

```
ham_radio_web_app/
├── package.json
├── server/                 # Express backend
│   ├── index.js            # entry point: HTTP + WS + services
│   ├── setup.js            # first-run bootstrap (admin user, JWT secret)
│   ├── storage.js          # JSON file persistence
│   ├── auth.js             # JWT + role middleware
│   ├── websocket.js        # real-time push to browsers
│   ├── routes/             # REST API
│   │   ├── auth.js         #   login, me, change-password
│   │   ├── users.js        #   user CRUD (admin)
│   │   ├── devices.js      #   status + control endpoints
│   │   ├── config.js       #   read/update configuration
│   │   └── themes.js       #   theme storage
│   └── services/           # device integration framework
│       ├── state.js        #   central live state + event bus
│       ├── serial.js       #   Palstar LA-1K (serialport)
│       ├── udp.js          #   PST Rotator + HF-Auto Tuner (dgram)
│       ├── mqtt.js         #   Home Assistant bridge (mqtt)
│       └── flexradio.js    #   FlexRadio 8600 discovery/TCP
├── client/                 # Frontend (vanilla JS, no build step)
│   ├── index.html          # login
│   ├── dashboard.html      # main UI
│   ├── css/styles.css      # theme-driven styling
│   └── js/                 # api, login, dashboard, theme, users
├── config/                 # JSON configuration & data
│   ├── config.template.json
│   ├── config.json         # generated on first run
│   ├── themes.json
│   └── users.json          # generated on first run
└── docs/                   # README / INSTALLATION / CONFIGURATION
```

---

## How control works

1. The browser authenticates and receives a JWT.
2. A **WebSocket** (`/ws?token=…`) streams device state to the dashboard in real time.
3. Control actions are **REST** calls (`POST /api/devices/...`). View-only users are
   blocked at the server (HTTP 403) **and** in the UI.
4. Backend **services** translate those calls into serial / UDP / MQTT messages and
   push resulting state changes back through the WebSocket.

---

## API summary

| Method & path | Role | Purpose |
|---|---|---|
| `POST /api/auth/login` | any | Get a token |
| `GET /api/auth/me` | any auth | Current user |
| `POST /api/auth/change-password` | any auth | Change own password |
| `GET /api/devices/status` | any auth | Full live state snapshot |
| `POST /api/devices/flex/rfpower` | admin/normal | Set FlexRadio RF power |
| `POST /api/devices/flex/apd` | admin/normal | Toggle APD |
| `POST /api/devices/amp/mode` | admin/normal | Operate / Standby |
| `POST /api/devices/amp/antenna` | admin/normal | Amp antenna 1–3 |
| `POST /api/devices/rotator/azimuth` | admin/normal | Turn rotator |
| `POST /api/devices/rotator/stop` | admin/normal | Stop rotator |
| `POST /api/devices/tuner/mode` | admin/normal | Tuner mode |
| `POST /api/devices/tuner/antenna` | admin/normal | Tuner antenna 1–3 |
| `POST /api/devices/power/:device` | admin/normal | Toggle supply/radio/amp |
| `GET/PUT /api/config` | admin | Read / save config |
| `GET /api/config/public` | any auth | UI-safe config subset |
| `GET /api/themes`, `POST /api/themes`, `PUT /api/themes/active`, `DELETE /api/themes/:id` | varies | Theme management |
| `GET/POST/PUT/DELETE /api/users` | admin | User management |

---

## Notes & limitations

- The device **services are a working framework** built from your Node-RED export.
  Serial, UDP (rotator + tuner) and MQTT use real protocols and will operate the
  hardware. The FlexRadio module implements discovery, the TCP channel, the
  subscription handshake and a status/meter parser covering the dashboard values;
  the SmartSDR command set can be extended in `server/services/flexradio.js`.
- If a library or device is missing, that service degrades gracefully (e.g. the amp
  enters *simulation mode*) and the rest of the app keeps running.
- This server is intended for a **trusted home LAN**. For internet exposure, place it
  behind a reverse proxy with HTTPS.

---

## License

MIT — free to use and modify for your own station.
