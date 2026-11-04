#!/bin/sh
# Installed by tools/setup.mjs as the pre-push hook of the crew's copy of the site (work/repo and its worktrees).
# The crew releases into the sandbox repo only. A push aimed at the live Kartavya repo is refused, whoever runs it.
# git passes the remote's name as $1 and its URL as $2.
case "$2" in
  *github.com/YashasviThakur/kartavya|*github.com/YashasviThakur/kartavya.git|*github.com:YashasviThakur/kartavya|*github.com:YashasviThakur/kartavya.git|BLOCKED*)
    echo "kartavya-crew: refusing to push to the live Kartavya repo ($2). The crew only pushes to the sandbox." >&2
    exit 1 ;;
esac
exit 0
