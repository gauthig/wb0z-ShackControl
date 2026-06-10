# Installation Guide — Windows 11

This guide walks you through installing and running the **Ham Radio Web App** on a
Windows 11 PC (the same machine that currently runs Node-RED). No prior Node.js
experience is required — just follow each step in order.

---

## 1. Install Node.js (LTS)

The app runs on **Node.js 18 or newer** (20 LTS recommended).

1. Open a browser and go to **https://nodejs.org**.
2. Download the **LTS** installer for Windows (the `.msi` file, 64-bit).
3. Run the installer. Accept the license and keep all default options.
   - On the *Tools for Native Modules* screen, **leave the checkbox enabled**
     ("Automatically install the necessary tools…"). This is required so the
     `serialport` package can build for COM7. A small extra window (Chocolatey /
     Build Tools) may open and take several minutes — let it finish.
4. When the installer completes, click **Finish**.

### Verify the install
1. Press `Windows key`, type **cmd**, and open **Command Prompt**.
2. Run:
   ```bat
   node --version
   npm --version
   ```
   You should see version numbers (e.g. `v20.x.x` and `10.x.x`). If you get
   "not recognized", restart the PC and try again.

---

## 2. Copy the application to your PC

1. Download / copy the entire `ham_radio_web_app` folder to a location such as:
   ```
   C:\ham_radio_web_app
   ```
2. Make sure the folder contains these subfolders: `server`, `client`, `config`, `docs`.

---

## 3. Install dependencies

1. Open **Command Prompt**.
2. Change into the app folder:
   ```bat
   cd C:\ham_radio_web_app
   ```
3. Install the required packages:
   ```bat
   npm install
   ```
   This downloads Express, the serial/MQTT libraries, etc. It can take 1–3 minutes.
   - If you see warnings about `serialport`, ensure the build tools from Step 1 were
     installed. You can re-run `npm install` after installing them.

---

## 4. Configure your station

The app ships with a configuration **template** already filled in with your
extracted Node-RED settings (COM7, UDP ports, MQTT broker `192.168.1.54`, etc.).

1. On first launch the app automatically creates `config\config.json` from
   `config\config.template.json`. You do **not** need to create it by hand.
2. To review or change settings, open `config\config.json` in **Notepad** after the
   first run, or edit `config\config.template.json` **before** the first run.
3. See **docs\CONFIGURATION.md** for an explanation of every setting.

Key things to confirm:
- **Serial port** for the Palstar LA-1K amp is `COM7` (Device Manager → Ports).
- **MQTT broker** address matches your Home Assistant Mosquitto (`192.168.1.54:1883`).
- **UDP ports** for PST Rotator (12000/12001) and HF-Auto tuner (13080/12020) match
  the ports configured in those applications.

---

## 5. Start the server

From the app folder in Command Prompt:
```bat
npm start
```

You should see:
```
========================================================
  WB0Z - Flex 8600
  HTTP + WebSocket listening on http://0.0.0.0:3000
  Open http://localhost:3000 in your browser.
========================================================
```

On the **first** start the app also creates the default admin account:
```
[setup] Created default admin user 'wb0z'.
```

> **Note:** If COM7 is not present (e.g. the amp is off), you will see a
> "Could not open COM7" message. This is harmless — the app keeps running and will
> connect automatically when the port becomes available.

---

## 6. Log in

1. On the same PC, open a browser to **http://localhost:3000**.
2. Sign in with the pre-configured admin account:
   - **Username:** `wb0z`
   - **Password:** `Jasonar-8806`
3. **Change the admin password immediately** using the *Change Password* button in
   the top-right corner.

---

## 7. Access from other devices on your network (optional)

The server listens on all network interfaces, so a tablet or laptop on the same
LAN can reach it.

1. Find your PC's local IP: in Command Prompt run `ipconfig` and note the
   **IPv4 Address** (e.g. `192.168.1.50`).
2. On the tablet's browser, go to `http://192.168.1.50:3000`.
3. **Windows Firewall**: the first time, Windows may prompt to allow Node.js
   through the firewall — click **Allow access** (Private networks). If you missed
   the prompt, add an inbound rule for TCP port **3000** in *Windows Defender
   Firewall → Advanced Settings*.

---

## 8. Run automatically on boot (optional)

To keep the app running and start it with Windows, use **PM2**:

```bat
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd C:\ham_radio_web_app
pm2 start server/index.js --name ham-radio
pm2 save
```

To view logs: `pm2 logs ham-radio`. To stop: `pm2 stop ham-radio`.

Alternatively, create a simple `start.bat` file containing:
```bat
@echo off
cd /d C:\ham_radio_web_app
npm start
```
and place a shortcut to it in your Startup folder (`shell:startup`).

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `node` not recognized | Reinstall Node.js, restart the PC. |
| `npm install` fails on serialport | Install the *Tools for Native Modules* from the Node.js installer, then re-run. The app still runs without it (amp in simulation mode). |
| Can't reach from tablet | Check Windows Firewall inbound rule for port 3000; confirm both devices are on the same network. |
| COM7 won't open | Confirm the amp is powered and the correct port number in Device Manager; update `serial.palstar_la1k_amp.serial_port` in `config.json`. |
| Port 3000 already in use | Change `site.http_port` in `config.json` to another port (e.g. 8080). |
| Forgot admin password | Stop the app, delete `config\users.json`, restart — the default `wb0z` admin is recreated. |

---

For configuration details see **CONFIGURATION.md**. For feature overview see **README.md**.
