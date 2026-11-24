# Runs on your Windows machine, from the repo folder. Copies the source to the
# Sprite with `sprite file push` (no GitHub credentials ever go on the Sprite),
# then runs the setup script there.
#
#   .\scripts\deploy.ps1                      # Sprite "banquet-captain"
#   .\scripts\deploy.ps1 -Sprite captain-2    # a second Sprite for the MIA handoff demo
param(
  [string]$Sprite = "banquet-captain",
  [string]$AgentId = ""
)
$ErrorActionPreference = "Stop"
if (-not $AgentId) { $AgentId = $Sprite }
Set-Location (Split-Path -Parent $PSScriptRoot)

$remoteHome = (sprite exec -s $Sprite -- bash -lc 'echo $HOME').Trim()
if (-not $remoteHome) { throw "Could not read HOME on Sprite $Sprite." }
$dest = "$remoteHome/banquet-captain"
Write-Host "== pushing to ${Sprite}:$dest"

sprite exec -s $Sprite -- bash -lc "mkdir -p '$dest'"
foreach ($item in @("package.json", "package-lock.json", "tsconfig.json", "README.md")) {
  if (Test-Path $item) { sprite file push $item "${Sprite}:$dest/$item" }
}
foreach ($dir in @("src", "test", "scripts")) {
  sprite file push -r $dir "${Sprite}:$dest/"
}

Write-Host "== setup on $Sprite"
sprite exec -s $Sprite -- bash -lc "chmod +x '$dest/scripts/sprite-setup.sh' && '$dest/scripts/sprite-setup.sh' '$AgentId'"
