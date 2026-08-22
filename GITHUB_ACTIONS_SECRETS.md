# SquashLevels credentials in GitHub Actions

Do not commit your real `config.json` credentials.

Create repository secrets:
- `SQUASHLEVELS_EMAIL`
- `SQUASHLEVELS_PASSWORD`

Then add them to the step that runs the refresh:

```yaml
- name: Refresh tournament data
  env:
    HEADLESS: '1'
    SQUASHLEVELS_EMAIL: ${{ secrets.SQUASHLEVELS_EMAIL }}
    SQUASHLEVELS_PASSWORD: ${{ secrets.SQUASHLEVELS_PASSWORD }}
  run: npm run refresh
```

For local runs, fill in `config.json` instead.
