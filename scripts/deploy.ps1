# Runs on your Windows machine, from the repo folder. The Sprite clones this
# public repo itself (no GitHub credentials go on the Sprite), checks out the
# branch you have checked out here, then runs the setup script there.
# Only pushed commits deploy: local edits that aren't on GitHub stay here.
#
#   .\scripts\deploy.ps1                      # Sprite "banquet-captain", current branch
#   .\scripts\deploy.ps1 -Ref main            # a specific branch
#   .\scripts\deploy.ps1 -Sprite captain-2    # a second Sprite for the MIA handoff demo
param(
  [string]$Sprite = "banquet-captain",
  [string]$AgentId = "",
  [string]$Ref = "",
  [string]$Repo = "https://github.com/flasun/banquet-captain"
)
$ErrorActionPreference = "Stop"
if (-not $AgentId) { $AgentId = $Sprite }
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not $Ref) { $Ref = (git rev-parse --abbrev-ref HEAD).Trim() }
if ($Ref -notmatch '^[A-Za-z0-9._/-]+$') { throw "Unexpected branch name: $Ref" }

# The last line is HOME; anything before it is shell start-up noise.
$remoteHome = (sprite exec -s $Sprite -- bash -lc 'echo $HOME' | Select-Object -Last 1).Trim()
if ($remoteHome -notmatch '^/[A-Za-z0-9._/-]+$') { throw "Could not read HOME on Sprite $Sprite (got '$remoteHome')." }
$dest = "$remoteHome/banquet-captain"

# Plain POSIX paths inside one bash command, so the Windows sprite CLI never treats them as file paths.
# git clone works into an empty folder and refuses a non-empty one, so nothing is ever deleted.
Write-Host "== $Sprite checks out $Ref into $dest"
$fetch = "set -e; command -v git >/dev/null || { echo 'git is not installed on the Sprite' >&2; exit 1; }; " +
  "if [ -d '$dest/.git' ]; then git -C '$dest' fetch -q --depth 1 origin '$Ref'; git -C '$dest' checkout -q --force FETCH_HEAD; " +
  "else git clone -q --depth 1 --branch '$Ref' '$Repo' '$dest'; fi; git -C '$dest' log -1 --oneline"
sprite exec -s $Sprite -- bash -lc $fetch
if ($LASTEXITCODE -ne 0) { throw "Checkout on $Sprite failed. Is '$Ref' pushed to GitHub?" }

Write-Host "== setup on $Sprite"
sprite exec -s $Sprite -- bash -lc "chmod +x '$dest/scripts/sprite-setup.sh' && '$dest/scripts/sprite-setup.sh' '$AgentId'"
if ($LASTEXITCODE -ne 0) { throw "Setup on $Sprite failed; see the output above." }
