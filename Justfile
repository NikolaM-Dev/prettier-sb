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

# Keep in sync with upstream (prettier/prettier)
# Handles your 3 manual steps automatically:
#   1. ignores .github/workflows  (keeps fork deletion)
#   2. merges package.json keeping fork-only deps/scripts (@types/prettier, vitest, test:second-brain, build:second-brain) while taking upstream version bumps
#   3. restores yarn.lock then regenerates via yarn install (rm -rf node_modules)
# plus runs test:second-brain to gate the push
update:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "→ Switching to main..."
    git switch main

    echo "→ Fetching upstream..."
    git fetch upstream || { echo "⚠ git fetch upstream failed (check ssh key), trying to continue with local upstream/main..."; }

    # Abort any stale merge from a previous interrupted update
    if git rev-parse --verify MERGE_HEAD >/dev/null 2>&1; then
        echo "→ Aborting previous incomplete merge..."
        git merge --abort || true
    fi

    echo "→ Merging upstream/main..."
    set +e
    git merge upstream/main --no-edit
    MERGE_STATUS=$?
    set -e

    if [ $MERGE_STATUS -eq 0 ]; then
        echo "✓ Merge completed with no conflicts."
    else
        echo "⚠ Conflicts detected — auto-resolving expected files..."

        # 1. .github/workflows — fork intentionally deletes this, upstream keeps updating it.
        # Keep our deletion. Git usually auto-keeps the deletion, but handle it explicitly.
        if git status --porcelain | grep -q "github/workflows" || [ -d ".github/workflows" ]; then
            echo "  → Ignoring .github/workflows (keeping fork deletion)..."
            git rm -rf .github/workflows 2>/dev/null || true
            rm -rf .github/workflows 2>/dev/null || true
            # Also clear from index if staged as added by merge
            git rm -rf --cached .github/workflows 2>/dev/null || true
            rm -rf .github/workflows 2>/dev/null || true
        fi

        # 2. package.json — always conflicts because fork adds extra deps/scripts
        if git diff --name-only --diff-filter=U | grep -q "^package.json$"; then
            echo "  → Merging package.json (preserving fork-only deps/scripts)..."
            node ./scripts/tools/merge-package-json.mjs
            git add package.json
            echo "    ✓ package.json merged"
        fi

        # 3. yarn.lock — don't try to merge, just restore HEAD and regenerate
        if git diff --name-only --diff-filter=U | grep -q "^yarn.lock$"; then
            echo "  → Restoring yarn.lock from HEAD (will be regenerated)..."
            git checkout --ours -- yarn.lock 2>/dev/null || git checkout HEAD -- yarn.lock 2>/dev/null || true
            git add yarn.lock 2>/dev/null || true
            echo "    ✓ yarn.lock restored"
        fi

        # Fail if any unexpected file is still conflicted
        REMAINING="$(git diff --name-only --diff-filter=U || true)"
        if [ -n "$REMAINING" ]; then
            # Filter to only unexpected files
            UNEXPECTED="$(echo "$REMAINING" | grep -v -E "^(package\.json|yarn\.lock)$" || true)"
            if [ -n "$UNEXPECTED" ]; then
                echo "✗ Unexpected conflicts remain in:"
                echo "$UNEXPECTED" | sed 's/^/  - /'
                echo "  Please resolve manually, then: git status && git add <files> && git commit"
                exit 1
            fi
            # If only expected files remain but still marked unmerged, re-check
            if git status --porcelain | grep -q "^UU\|^AA\|^DD\|^AU\|^UA"; then
                echo "✗ Still have unmerged paths after auto-resolve:"
                git status --porcelain | grep "^UU\|^AA\|^DD"
                exit 1
            fi
        fi

        echo "→ Regenerating lockfile (rm -rf node_modules + yarn install)..."
        rm -rf node_modules .yarn/install-state.gz 2>/dev/null || true
        yarn install
        git add yarn.lock 2>/dev/null || true

        # Yarn install shouldn't re-create workflows, but ensure again
        if [ -d ".github/workflows" ]; then
            echo "  → Cleaning stray .github/workflows..."
            git rm -rf .github/workflows 2>/dev/null || true
            rm -rf .github/workflows 2>/dev/null || true
        fi
        git rm -rf --cached .github/workflows 2>/dev/null || true

        echo "→ Building second-brain package..."
        bun run build:second-brain 2>/dev/null || yarn build:second-brain

        echo "→ Merge auto-resolved. Staged changes:"
        git status --short
    fi

    # Ensure workflows stay deleted even on a clean merge (upstream may have added them without conflict)
    if [ -d ".github/workflows" ]; then
        echo "→ Removing .github/workflows added by upstream (fork keeps it deleted)..."
        git rm -rf .github/workflows 2>/dev/null || true
        rm -rf .github/workflows 2>/dev/null || true
        if git rev-parse --verify MERGE_HEAD >/dev/null 2>&1; then
            echo "  (included in pending merge commit)"
        else
            # Clean-merge path: commit the deletion separately if needed
            if ! git diff --quiet || ! git diff --cached --quiet; then
                git add -A 2>/dev/null || true
                git rm -rf --cached .github/workflows 2>/dev/null || true
                if ! git diff --cached --quiet; then
                    git commit -m "chore: ignore .github/workflows from upstream" || true
                fi
            fi
        fi
    fi

    # Fresh install if not already done in conflict path
    if git rev-parse --verify MERGE_HEAD >/dev/null 2>&1; then
        # Still in merge — install already done above if conflicted
        true
    else
        # Clean merge path still needs install to pick up upstream bump
        if ! git diff --name-only HEAD@{1}..HEAD 2>/dev/null | grep -q "yarn.lock"; then
            # No lock change detected via reflog, just ensure deps are fresh
            true
        fi
        echo "→ Installing dependencies..."
        # Keep your habit of removing node_modules before reinstall
        rm -rf node_modules 2>/dev/null || true
        yarn install
        echo "→ Building second-brain package..."
        bun run build:second-brain 2>/dev/null || yarn build:second-brain
    fi

    echo "→ Running test:second-brain to gate the merge..."
    if command -v bun >/dev/null 2>&1; then
        bun run test:second-brain
    else
        yarn test:second-brain
    fi
    echo "✓ Tests passed."

    # Finalize merge commit if still pending
    if git rev-parse --verify MERGE_HEAD >/dev/null 2>&1; then
        echo "→ Committing merge..."
        git commit --no-edit
        echo "✓ Merge committed."
    else
        echo "✓ Update ready."
    fi

    echo ""
    echo "Next: git push origin main"
    git log --oneline -3 | sed 's/^/  /'
    git status --short | sed 's/^/  /'
