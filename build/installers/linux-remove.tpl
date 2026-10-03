# Remove only links owned by this installation, including broken links.
for command in cibyp cibyp-tui; do
    target='/opt/${sanitizedProductName}/resources/cli/'"$command"
    destination="/usr/bin/$command"
    if [ "$(readlink "$destination")" = "$target" ]; then rm -f "$destination"; fi
done
