# Quartermaster Orchestrator — VPS access & operations

**Host:** `orchestrator.ai-storystudio.com` → `129.121.78.38` (Bluehost VPS NVMe8, Ubuntu 24.04,
4 vCPU / 8 GB / 200 GB, hostname `hal-server-861762`).
**Role:** the background-path orchestrator only — Postgres + the orchestrator process + a Caddy
TLS proxy. It is **not** the box running `agent.ai-storystudio.com` / `social.ai-storystudio.com`.

> This document contains **no secrets**. The root password lives only in the local, git-ignored
> `docs/Orchestrator-vps-login.txt` (kept for console-recovery fallback). SSH is key-only —
> password login is disabled.

---

## 1. SSH in

Login is **key-only** (`PasswordAuthentication no`). The private key is on the operator's
workstation at `~/.ssh/ai-storystudio-vps`, with this block in `~/.ssh/config`:

```
Host orchestrator ai-storystudio-vps
    HostName 129.121.78.38
    User root
    IdentityFile ~/.ssh/ai-storystudio-vps
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 4
```

Then:

```sh
ssh orchestrator
```

To authorise another machine: append its ed25519 **public** key to `/root/.ssh/authorized_keys`
(one key per line). Do not remove the existing `access@hal` line — that is Bluehost's
console-recovery key.

**Lost the key / locked out:** use the Bluehost panel's web console (VNC) to log in with the
root password from `docs/Orchestrator-vps-login.txt`, then re-add a key.

---

## 2. What runs there

Everything is Docker Compose under `/opt/qm-orchestrator/`:

```
/opt/qm-orchestrator/
├── .env                 # PGUSER/PGPASSWORD/PGDATABASE, ORCH_INGEST_TOKEN, ORCH_WEBHOOK_SECRET  (chmod 600, not in git)
├── docker-compose.yml
├── caddy/Caddyfile
└── repo/                # full monorepo clone (git remote = public GitHub)
```

| Service | Image | Ports | Notes |
|---|---|---|---|
| `db` | `postgres:16` | — (compose net only) | volume `pgdata`; migrations `001`–`005` applied |
| `orchestrator` | built from `./repo/orchestrator` | `127.0.0.1:8080` | Fastify; `GET /v1/health` |
| `caddy` | `caddy:2` | `0.0.0.0:80`, `0.0.0.0:443` | auto-TLS for `orchestrator.ai-storystudio.com` (Let's Encrypt) |

Public entrypoint: `https://orchestrator.ai-storystudio.com` → Caddy → `orchestrator:8080`.

---

## 3. Deploy a new version

The orchestrator image is built on the box from the checked-out repo. Migrations are an
**explicit step** — never automatic on boot.

```sh
cd /opt/qm-orchestrator
git -C repo pull
docker compose build orchestrator
docker compose run --rm orchestrator node dist/db/migrate.js up      # apply any new migrations
docker compose up -d orchestrator                                    # roll the service
curl -s https://orchestrator.ai-storystudio.com/v1/health && echo
```

Migration runner (`node dist/db/migrate.js …`), always via `docker compose run --rm orchestrator`:

| Command | Effect |
|---|---|
| `… migrate.js status` | list applied `[x]` / pending `[ ]` |
| `… migrate.js up` | apply every pending migration (one txn each) |
| `… migrate.js down` | revert the most recently applied migration |

---

## 4. Operate

```sh
cd /opt/qm-orchestrator

docker compose ps                             # container status
docker compose logs -f --tail=100 orchestrator
docker compose logs --tail=50 caddy           # TLS / ACME issues show here
docker compose restart orchestrator
docker compose up -d                          # reconcile the whole stack to compose file

# health
curl -s https://orchestrator.ai-storystudio.com/v1/health          # via Caddy (public)
curl -s http://127.0.0.1:8080/v1/health                            # direct (on the box)

# database shell
docker compose exec db psql -U qm -d qm_orchestrator
```

`/v1/health` returns `200` with `{"status":"ok","pg":{"ok":true,...}}` when Postgres is
reachable, `503` when it is not.

---

## 5. Backups

`pgdata` is a Docker named volume on `/`. Nightly logical dump to object storage is **not yet
wired** — until it is, take a manual dump before anything risky:

```sh
docker compose exec -T db pg_dump -U qm -Fc qm_orchestrator > /opt/qm-orchestrator/backup-$(date +%F).dump
```

Restore: `docker compose exec -T db pg_restore -U qm -d qm_orchestrator --clean < <file>`.

Spec §15.3 calls for `pg_dump` nightly to object storage + WAL archiving to an off-box mirror —
outstanding.

---

## 6. TLS

Caddy obtains and auto-renews the `orchestrator.ai-storystudio.com` certificate from Let's
Encrypt (TLS-ALPN-01 on :443). Cert + account state live in the `caddy_data` volume. Nothing to
do on renewal. If issuance fails, check `docker compose logs caddy` — usually DNS or a blocked
:80/:443.

DNS: single **A record** `orchestrator.ai-storystudio.com` → `129.121.78.38` (TTL 300). No
dedicated IP needed — Caddy serves the one host by SNI.

---

## 7. Firewall & SSH hardening

`ufw`: `22`, `80`, `443` open. (Docker publishes container ports via its own iptables chain,
so `80`/`443` are reachable regardless of `ufw` — expected here.)

SSH hardening is `/etc/ssh/sshd_config.d/00-hardening.conf` (named `00-` so it wins over
Ubuntu's `50-cloud-init.conf`, which is first-match):

```
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
```

Verify effective config: `sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin|pubkeyauthentication) '`.
After editing, `sshd -t && systemctl restart ssh`, and confirm a **new** session logs in
before closing the current one.

---

## 8. Outstanding

- [ ] rotate the root password (`passwd root`) away from the value in `Orchestrator-vps-login.txt`
- [ ] remove the unused deploy key `/root/.ssh/qm_repo_deploy*` (left over from when the repo was private)
- [ ] nightly `pg_dump` → object storage + off-box Postgres mirror (spec §15.3)
- [ ] `qm-watchdog` as its own container/unit (spec §6.9) — arrives with M3
