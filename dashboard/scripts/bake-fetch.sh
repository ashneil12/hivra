fetch() {
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --max-time 300 "$1" --output "$3"
  printf '%s  %s\n' "$2" "$3" | sha256sum --check --status -
}
