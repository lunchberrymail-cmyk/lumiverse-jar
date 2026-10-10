# Lumiverse on a phone, JAR on a Windows PC

Install the extension through Lumiverse's **Install from Source** using the repository URL. This step needs no SSH setup and does not install JAR or Chromium on the phone.

Start the authenticated JAR companion on the PC with `node companion/start.cjs PATH_TO_JAR` and complete JanitorAI sign-in in its Chromium. Its default listener is PC `127.0.0.1:4577`. The phone's `127.0.0.1` refers to the phone, so a connection path is needed between the devices.

## Optional SSH reverse forward

If the phone runs an SSH server reachable from the PC, a reverse forward keeps the JAR listener on loopback. From the PC, replace the placeholder values and run:

```text
ssh -N -o ExitOnForwardFailure=yes -p PHONE_SSH_PORT -R 127.0.0.1:4577:127.0.0.1:4577 PHONE_USER@PHONE_IP
```

Verify the phone's SSH host fingerprint before accepting the connection. The forward listens only on **phone `127.0.0.1:4577`** and sends requests to **PC `127.0.0.1:4577`**. Keep both this SSH connection and JAR running.

In the phone's Lumiverse panel, set **Optional JAR connection → Companion URL** to `http://127.0.0.1:4577`, enter the companion token printed on the PC, and choose **Save and test connection**. The full workspace link also needs an address reachable by the phone's browser; this same loopback address works when that browser runs on the forwarded phone.

An authenticated HTTPS reverse proxy is another connection option. Remote companion addresses require HTTPS in the extension. This repository does not configure device discovery, LAN listeners, firewall rules, SSH accounts, or tunnels automatically. Actual phone installation and pairing remain unverified.
