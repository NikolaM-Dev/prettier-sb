# List available recipes
default:
    just --list

# Build the prettier binary
build:
    yarn install
    bun run build:second-brain

build_watch:
    watchexec -e .ts,.js 'bun run build:second-brain'

# Install `prettier-sb` into `$HOME/.local/bin`
install: build
    ln -sf "$(pwd)/dist/prettier/bin/prettier.cjs" "$HOME/.local/bin/prettier-sb"

# Test `second-brain` functionality
test:
    bun run test:second-brain

# Keep in sync with upstream (prettier/prettier).
#
# `just update` is a thin wrapper around `scripts/tools/update-from-upstream.mjs`,
# which does the whole job: merge upstream, keep .github/workflows deleted,
# re-inject the fork's package.json extras (upstream versions win for shared deps),
# regenerate + verify yarn.lock, then build and test before committing.
#
# Arguments are forwarded, so all of these work:
#   just update
#   just update --dry-run
#   just update --no-test --no-commit
#   just update -- --json

# Sync with upstream
update *ARGS:
    node ./scripts/tools/update-from-upstream.mjs {{ARGS}}
