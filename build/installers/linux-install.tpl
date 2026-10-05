# CIBYP terminal and graphical commands. Preserve unrelated commands.
for command in cibyp cibyp-tui cibyp-code cibyp-webui; do
    target='/opt/${sanitizedProductName}/resources/cli/'"$command"
    destination="/usr/bin/$command"
    if [ -e "$destination" ] || [ -L "$destination" ]; then
        if [ "$(readlink "$destination")" != "$target" ]; then
            echo "Cannot register $command: $destination is owned by another installation" >&2
            exit 1
        fi
    fi
    ln -sfn "$target" "$destination"
done
