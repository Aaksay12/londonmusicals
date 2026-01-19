# London Musicals - Project Summary

## Overview
A Cloudflare Workers application for listing musicals currently playing in London. Features a public listing page and an admin panel for managing shows.

**Live URL:** https://london-musicals.musical-london.workers.dev

## Tech Stack
- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **Authentication:** HTTP Basic Auth (admin panel)
- **Cron:** Daily at 6:00 AM UTC

## Database Schema

### Table: `musicals`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key, auto-increment |
| run_id | TEXT | Unique slug: `title-venue-start_date` (for upsert) |
| title | TEXT | Show title |
| venue_name | TEXT | Theatre name |
| venue_address | TEXT | Full address for Google Maps |
| type | TEXT | `West End`, `Off West End`, or `Drama School` |
| start_date | DATE | When the run started |
| end_date | DATE | When run ends (NULL = open run) |
| description | TEXT | Short description |
| ticket_url | TEXT | Main ticket booking URL |
| price_from | REAL | Starting price in GBP |
| schedule | TEXT | JSON with weekly show times |
| lottery_url | TEXT | Lottery ticket URL |
| lottery_price | REAL | Lottery ticket price |
| rush_url | TEXT | Rush ticket URL |
| rush_price | REAL | Rush ticket price |
| created_at | DATETIME | Record creation timestamp |
| updated_at | DATETIME | Last update timestamp |

### Indexes
- `idx_musicals_run_id` (UNIQUE) - For upsert matching
- `idx_musicals_dates` - For date range filtering
- `idx_musicals_type` - For type filtering

## Schedule JSON Format

Stores actual show times (or null if no performance):

```json
{
  "mon": {"m": null, "e": "19:30"},
  "tue": {"m": null, "e": "19:30"},
  "wed": {"m": "14:30", "e": "19:30"},
  "thu": {"m": "14:30", "e": "19:30"},
  "fri": {"m": null, "e": "19:30"},
  "sat": {"m": "14:30", "e": "19:30"},
  "sun": {"m": "15:00", "e": null}
}
```
- `m` = matinee time (e.g., "14:30")
- `e` = evening time (e.g., "19:30")
- `null` = no performance

## Public Page Features

### Filters
- **Type filters:** All Shows, West End, Off West End, Drama Schools, Rush & Lottery
- **Date filters:** Today, This Week, This Month, This Quarter (default)
- **Custom date range:** From/To date pickers with Apply/Clear

### Show Cards Display
- Show title and type badge
- Venue name with location icons (📍 map, 🧭 directions)
- Description
- Weekly schedule grid with actual times
- End date (or "Open run")
- Price from
- Rush (⚡) and Lottery (🎲) badges with prices (top-right corner, clickable)
- Get Tickets button

### Schedule Display
Shows times in 12-hour format across 7 days:
```
  M      T      W      T      F      S      S
  -      -    2:30pm 2:30pm   -    2:30pm 3:00pm
7:30pm 7:30pm 7:30pm 7:30pm 7:30pm 7:30pm   -
```

### Day Filtering
When a single day is selected, shows are filtered by their weekly schedule (only shows performing that day appear).

## Admin Panel

**URL:** `/admin` (requires Basic Auth)

### Features
1. **Add/Edit Musical** - Form with all fields including schedule grid
2. **CSV Import** - Bulk import with upsert logic
3. **Export Data** - Download all data as CSV
4. **Download Template** - Get CSV template
5. **Migrate Run IDs** - Generate run_ids for legacy records
6. **Delete All** - Clear database (requires password re-confirmation)

### Upsert Logic
- `run_id` = normalized slug from `title + venue_name + start_date`
- Import checks run_id: if exists → UPDATE, if new → INSERT
- Handles: same show at new venue (new record), same show new season (new record)

## API Endpoints

### Public
- `GET /api/musicals` - List active musicals (with optional `?type=` filter)
- `GET /api/musicals/:id` - Get single musical
- `GET /api/stats` - Get counts by type

### Admin (requires auth)
- `GET /admin/api/musicals` - List all musicals
- `POST /admin/api/musicals` - Create musical
- `PUT /admin/api/musicals/:id` - Update musical
- `DELETE /admin/api/musicals/:id` - Delete musical
- `POST /admin/api/musicals/import` - Bulk import (upsert)
- `POST /admin/api/delete-all` - Delete all (requires password)
- `POST /admin/api/migrate-run-ids` - Populate run_ids

## Files

```
londonmusicals/
├── worker.js                    # Main worker code (all-in-one)
├── wrangler.toml                # Cloudflare config
├── schema.sql                   # Database schema
├── west-end-musicals-import.csv # Sample import data
├── show-times.md                # Reference schedule data
└── SUMMARY.md                   # This file
```

## Environment Variables (Secrets)

Set via `wrangler secret put`:
- `ADMIN_USERNAME` - Admin panel username
- `ADMIN_PASSWORD` - Admin panel password

## Wrangler Config

```toml
name = "london-musicals"
main = "worker.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "london-musicals-db"
database_id = "797f3ed8-e675-4ed4-babb-9d0669a8456f"

[triggers]
crons = ["0 6 * * *"]
```

## Deployment

```bash
# Deploy
npx wrangler deploy

# Database commands
npx wrangler d1 execute london-musicals-db --remote --command="SQL HERE"
```

## Git Repository

https://github.com/Aaksay12/londonmusicals
