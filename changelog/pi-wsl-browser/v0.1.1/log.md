# pi-wsl-browser v0.1.1

## fix

- Remove the npm dependency on pi-shelld. Install and load both Pi extensions independently; browser sessions discover the shell service through `pi.events`.
- Update installation instructions to describe the independent extension setup.
