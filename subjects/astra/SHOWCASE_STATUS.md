# AI showcase status

PC and Android phone are now authenticated to Tailscale. A preview server is running bound specifically to the PC's private Tailscale interface:

http://100.103.254.53:4174/?showcase=1

The private address responded with HTTP 200 on the PC. Phone-side loading still needs confirmation. Keep Tailscale connected on the phone. HTTPS Serve is awaiting tailnet enablement, so this direct private address is the current viewing link. The server is not bound to the public or LAN interfaces.

Implemented and running locally at http://127.0.0.1:4173/?showcase=1.

Start again with `npm run showcase`. This builds the current project and runs the preview server on port 4173. Keep this process and the PC awake while accessing it remotely.

The showcase automatically starts AI, blocks driving takeover/recovery/manual shifting, provides camera and telemetry buttons, defaults to performance quality and muted audio, and cycles finished races after 12 seconds. Optional URL parameters: `laps=3|5|10`, `field=4|6|8`, `camera=chase|bonnet|cockpit|trackside|engineer`, `pace=race|qualifying`.

Verified: 52 tests pass; production build passes; automatic AI start, takeover lockout, camera/telemetry buttons and 844×390 landscape layout checked in browser. No browser errors captured. Race-cycle deadline has automated coverage; a full browser race cycle and real phone/cellular performance remain unverified.

Remote access is pending: Tailscale installation was launched through winget, but the installer has not completed. Accept any Windows installer elevation prompt, then sign into Tailscale on the PC and phone using the same account. After login, run `tailscale serve --bg 4173` and append `/?showcase=1` to the HTTPS address it reports. The localhost address above only works on the PC.

This serves the application to the phone, which runs its own AI race. It does not mirror the PC's exact race or desktop. No public tunnel, persistent Windows startup task, or power-setting changes were made.
