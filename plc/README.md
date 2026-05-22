# Local PLC directory

Replaces the public `plc.directory` for the local AIT network. Mints and serves `did:plc:...` identifiers.

## One-time setup

```bash
# 1. Install Postgres (if not already installed)
brew install postgresql@16
brew services start postgresql@16

# 2. Create the PLC database
createdb plc_directory

# 3. Copy env template and fill in the admin secret
cp .env.example .env
sed -i '' "s/ADMIN_SECRET=/ADMIN_SECRET=$(openssl rand -hex 32)/" .env

# 4. Install Node deps
npm install
```

## Run

```bash
# Loads .env, starts the server on port 2582
set -a; source .env; set +a; npm start
```

## Verify

```bash
curl http://localhost:2582/_health
# expect: {"version":"..."}
```
