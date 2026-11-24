# Marquee

Marquee is a desktop client for a personal Plex server. It plays movies, TV, music, and Live TV, and
it supports picture-in-picture, downloads, casting from other Plex apps, and automatic updates.

## Download

| Platform | Installer |
|---|---|
| Windows 10 and 11 | [Marquee.Setup.0.3.0.exe](https://github.com/camjewell11/CamPlex/releases/download/v0.3.0/Marquee.Setup.0.3.0.exe) |
| macOS (Apple silicon and Intel) | [Marquee-0.3.0-universal.dmg](https://github.com/camjewell11/CamPlex/releases/download/v0.3.0/Marquee-0.3.0-universal.dmg) |

For every version, see [Releases](https://github.com/camjewell11/CamPlex/releases).

## Install on Windows

1. Download the `.exe` file and open it.
2. Windows SmartScreen warns that the publisher is unknown, because the installer isn't signed.
   Click **More info**, and then click **Run anyway**.
3. Follow the installer. Marquee installs for your user account and adds desktop and Start menu
   shortcuts.

Marquee checks for a newer release each time it starts and offers to install it.

## Install on macOS

1. Download the `.dmg` file and open it.
2. Drag **Marquee** to the **Applications** folder.
3. Open Marquee from **Applications**. Because the app isn't notarized by Apple, macOS blocks it the
   first time.
4. Open **System Settings** > **Privacy & Security**, scroll to the message about Marquee, and click
   **Open Anyway**. Then confirm.

If macOS says that Marquee is damaged, run this command in Terminal, and then open the app again:

```sh
xattr -cr /Applications/Marquee.app
```

On macOS, Marquee tells you when a newer release exists and opens its download in your browser.

## Sign in

Click **Sign in with Plex**. Marquee opens plex.tv in your browser. After you sign in there, Marquee
finds your server. The sign-in is stored on your computer, encrypted with your Windows account or
your macOS keychain.

## Build from source

You need Node.js 22 or later.

```sh
npm install
npm start          # run from source
npm run dist       # Windows installer, in dist/
npm run dist:mac   # macOS disk image, in dist/ (must run on a Mac)
```

The **macOS build** workflow in GitHub Actions builds the disk image on a macOS runner and attaches
it to each published release.
