# CodeDroid – Spck-style code editor for Android (built by GitHub Actions)

## Get the APK
1. Create a new GitHub repo and upload everything in this folder (keep `.github/workflows/build-apk.yml`).
2. Open the repo's **Actions** tab → **Build Android APK** → **Run workflow** (also runs on every push to main).
3. When it finishes (~5–8 min), open the run and download the **CodeDroid-debug-apk** artifact, unzip, install `app-debug.apk`.

## Features
Multi-tab CodeMirror 6 editor (JS/TS/JSX, HTML, CSS, JSON, Markdown, Python), syntax highlighting, autocomplete, bracket matching,
find/replace, undo/redo, autosave, extra-keys bar, file explorer (create/rename/delete), multiple projects, search in files,
live HTML/CSS/JS preview with console + JS eval, full Git (clone, init, commit, push, pull, branches, history),
zip import/export + share, dark/light themes, font size, word wrap.

## Not included (needs native code)
FTP/SFTP, terminal / Node / npm, Emmet, language-server linting, diff viewer.
