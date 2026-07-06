# ⚠️ Deprecated ⚠️ OCCWeb terminal

*Читать на [русском](README.ru.md).*

### A web terminal for admins to launch Nextcloud's occ commands

![occweb](https://github.com/Adphi/OCCWeb/raw/main/appinfo/screenshot.png)


## ⚠️ Deprecated ⚠️
As nextcloudd has no native support for asynchronous operations, due to the use of php, this aplication is deprecated, and will no longer support the Nextcloud' future versions (19+). I did not find a way to implemement true support for interactive and long running occ tasks in a web terminal whitout introducing addtional dependencies (through websockets, for example), the lack of true asynchronous occ operations can lead to serious alterations of voluminous instances. 
[This issue](https://github.com/nextcloud/server/issues/16726) may give some hints on why I decided to not support this application anymore.


## Install

Place this app in **nextcloud/apps/**

## SQL query mode

Type `sql` in the terminal to switch into SQL query mode and run raw SQL
statements directly against the Nextcloud database (admin only). Separate
statements with `;`. Use **Shift+Enter** to add a new line and **Enter** to
run the whole block in a single request — this matters for scripts like
`SET vars.x = 'value'; SELECT current_setting('vars.x');`, since every
statement in one submission runs on the same database connection/session.
Type `occ` to switch back to the normal occ-command mode.

⚠️ There is no undo for `DELETE`/`UPDATE` statements — double check what
you are about to run, ideally against a non-critical row/user first.

## ⚠️ Warnings ⚠️

- The application is not a real interactive terminal and does not support long running tasks. 
So if your instance is pretty big, commands like `occ files:scan` will time out and fail.
- Do not use `occ maintenance:mode --on`, obvious...

## Deploying updates

After pulling/copying new code into `nextcloud/apps/occweb/`, restart PHP so
the changes actually take effect. `occ app:disable`/`app:enable` is **not**
enough — it does not clear PHP's opcode cache, so a stale, cached version of
the code can keep running (routes silently 404ing is a typical symptom).
Restart the PHP process itself, for example:

```bash
sudo systemctl restart php8.3-fpm   # adjust to your installed PHP version
sudo systemctl restart apache2      # if PHP runs as an Apache module instead
```

## TODOs:
See [open issues](https://github.com/Adphi/occweb/issues)
