# List avalible recipes
default:
    just --list

# Build the prettier binary
build:
    yarn install
    bun run build

build_watch:
    watchexec -e .ts,.js 'bun run build:second-brain'

# Install `prettier-sb` into `$HOME/.local/bin`
install: build
    ln -sf "$(pwd)/dist/prettier/bin/prettier.cjs" "$HOME/.local/bin/prettier-sb"

# Test `second-brain` functionality
test:
    bun run test:second-brain

# Keep update `upstream`
update:
    git switch main
    git pull upstream main
