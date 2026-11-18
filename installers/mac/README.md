# Marquee for Mac

These builds aren't signed or notarized by Apple, so macOS won't open them until you run one
Terminal command (step 4).

## Install

1. Pick the zip for your Mac. Open the Apple menu and choose **About This Mac**:
   - **Chip: Apple M1, M2, M3, M4…** → `Marquee-<version>-mac-arm64.zip`
   - **Processor: Intel…** → `Marquee-<version>-mac-x64.zip`
2. On GitHub, open the zip and click **Download raw file** (the download icon).
3. Double-click the downloaded zip to unzip it, then drag **Marquee** into **Applications**.
4. Open **Terminal** and run:

   ```sh
   xattr -cr /Applications/Marquee.app && codesign --force --deep --sign - /Applications/Marquee.app
   ```

   The first part removes the "downloaded from the internet" flag. The second re-signs the app for
   this Mac only, because packaging the app invalidated Electron's own signature.
5. Open Marquee from Applications or Launchpad.

Repeat steps 2–4 to update to a newer version.

## Building

On Windows or a Mac, `npm run dist:mac` writes both zips to `dist/`
(see `scripts/pack-mac.mjs`). Copy them here to publish them.
