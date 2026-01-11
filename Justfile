# List avalible recipes
default:
    just --list

# Build the prettier binary
build:
    yarn install
    bun run build

# Install `prettier-sb` into `$HOME/.local/bin`
install: build
    ln -sf "$(pwd)/dist/prettier/bin/prettier.cjs" "$HOME/.local/bin/prettier-sb"

# Test `second-brain` functionality
test_sb:
    bun run test:second-brain

# Test everything
tests:
    bun run test
