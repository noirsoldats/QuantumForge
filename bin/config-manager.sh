#!/bin/bash

# Quantum Forge Config Manager
# Backup, reset, and restore user data for development and testing

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Backup storage location
BACKUP_DIR="$HOME/.quantum-forge-backups"

# Determine the user data path based on OS
get_userdata_path() {
    case "$(uname -s)" in
        Darwin)
            echo "$HOME/Library/Application Support/Quantum Forge"
            ;;
        Linux)
            echo "$HOME/.config/Quantum Forge"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            # Windows via Git Bash, MSYS, or Cygwin
            echo "$APPDATA/Quantum Forge"
            ;;
        *)
            echo ""
            ;;
    esac
}

USERDATA_PATH=$(get_userdata_path)

if [[ -z "$USERDATA_PATH" ]]; then
    echo -e "${RED}Error: Unsupported operating system$(uname -s)${NC}"
    exit 1
fi

# Print formatted message
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get human-readable size
get_size() {
    local path="$1"
    if [[ -d "$path" ]]; then
        du -sh "$path" 2>/dev/null | cut -f1
    else
        echo "0"
    fi
}

# Ensure backup directory exists
ensure_backup_dir() {
    if [[ ! -d "$BACKUP_DIR" ]]; then
        mkdir -p "$BACKUP_DIR"
        print_info "Created backup directory: $BACKUP_DIR"
    fi
}

# Create a backup of the user data
cmd_backup() {
    if [[ ! -d "$USERDATA_PATH" ]]; then
        print_error "No user data found at: $USERDATA_PATH"
        print_info "The application may not have been run yet."
        exit 1
    fi

    ensure_backup_dir

    local timestamp=$(date +"%Y%m%d_%H%M%S")
    local backup_name="quantum-forge-backup-$timestamp"
    local backup_path="$BACKUP_DIR/$backup_name"

    print_info "Creating backup of user data..."
    print_info "Source: $USERDATA_PATH"
    print_info "Size: $(get_size "$USERDATA_PATH")"

    cp -r "$USERDATA_PATH" "$backup_path"

    print_success "Backup created: $backup_path"
    print_info "Backup size: $(get_size "$backup_path")"
}

# Reset user data to clean state
cmd_reset() {
    local keep_sde=false

    # Parse flags
    for arg in "$@"; do
        case $arg in
            --keep-sde)
                keep_sde=true
                ;;
        esac
    done

    if [[ ! -d "$USERDATA_PATH" ]]; then
        print_warning "No user data found at: $USERDATA_PATH"
        print_info "Nothing to reset."
        exit 0
    fi

    print_warning "This will delete all Quantum Forge user data!"
    print_info "Location: $USERDATA_PATH"
    print_info "Size: $(get_size "$USERDATA_PATH")"

    if [[ "$keep_sde" == true ]]; then
        print_info "The SDE (Static Data Export) will be preserved."
    fi

    echo ""
    read -p "Do you want to create a backup before resetting? (y/N): " backup_first
    if [[ "$backup_first" =~ ^[Yy]$ ]]; then
        cmd_backup
        echo ""
    fi

    read -p "Are you sure you want to reset? Type 'yes' to confirm: " confirm
    if [[ "$confirm" != "yes" ]]; then
        print_info "Reset cancelled."
        exit 0
    fi

    if [[ "$keep_sde" == true ]] && [[ -d "$USERDATA_PATH/sde" ]]; then
        # Move SDE to temp location
        local temp_sde=$(mktemp -d)
        print_info "Preserving SDE directory..."
        mv "$USERDATA_PATH/sde" "$temp_sde/"

        # Remove everything
        rm -rf "$USERDATA_PATH"

        # Restore SDE
        mkdir -p "$USERDATA_PATH"
        mv "$temp_sde/sde" "$USERDATA_PATH/"
        rmdir "$temp_sde"

        print_success "User data reset (SDE preserved)."
    else
        rm -rf "$USERDATA_PATH"
        print_success "User data completely removed."
    fi

    print_info "The application will start fresh on next launch."
}

# List available backups
cmd_list() {
    if [[ ! -d "$BACKUP_DIR" ]] || [[ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]]; then
        print_info "No backups found."
        print_info "Backup location: $BACKUP_DIR"
        exit 0
    fi

    echo ""
    echo "Available backups:"
    echo "=================="
    echo ""

    local index=1
    for backup in "$BACKUP_DIR"/quantum-forge-backup-*; do
        if [[ -d "$backup" ]]; then
            local name=$(basename "$backup")
            local size=$(get_size "$backup")
            # Extract date from backup name (format: quantum-forge-backup-YYYYMMDD_HHMMSS)
            local date_part=$(echo "$name" | sed 's/quantum-forge-backup-//' | sed 's/_/ /')
            local formatted_date=$(echo "$date_part" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1-\2-\3/')

            printf "  %2d) %s  [%s]\n" "$index" "$formatted_date" "$size"
            ((index++))
        fi
    done
    echo ""
}

# Restore from a backup
cmd_restore() {
    if [[ ! -d "$BACKUP_DIR" ]] || [[ -z "$(ls -A "$BACKUP_DIR" 2>/dev/null)" ]]; then
        print_error "No backups found."
        print_info "Backup location: $BACKUP_DIR"
        exit 1
    fi

    # Build array of backups
    local backups=()
    for backup in "$BACKUP_DIR"/quantum-forge-backup-*; do
        if [[ -d "$backup" ]]; then
            backups+=("$backup")
        fi
    done

    if [[ ${#backups[@]} -eq 0 ]]; then
        print_error "No backups found."
        exit 1
    fi

    echo ""
    echo "Available backups:"
    echo "=================="
    echo ""

    local index=1
    for backup in "${backups[@]}"; do
        local name=$(basename "$backup")
        local size=$(get_size "$backup")
        local date_part=$(echo "$name" | sed 's/quantum-forge-backup-//' | sed 's/_/ /')
        local formatted_date=$(echo "$date_part" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1-\2-\3/')

        printf "  %2d) %s  [%s]\n" "$index" "$formatted_date" "$size"
        ((index++))
    done
    echo ""

    read -p "Enter backup number to restore (or 'q' to cancel): " selection

    if [[ "$selection" == "q" ]] || [[ "$selection" == "Q" ]]; then
        print_info "Restore cancelled."
        exit 0
    fi

    if ! [[ "$selection" =~ ^[0-9]+$ ]] || [[ "$selection" -lt 1 ]] || [[ "$selection" -gt ${#backups[@]} ]]; then
        print_error "Invalid selection."
        exit 1
    fi

    local selected_backup="${backups[$((selection-1))]}"
    local backup_name=$(basename "$selected_backup")

    print_info "Selected: $backup_name"

    if [[ -d "$USERDATA_PATH" ]]; then
        print_warning "Existing user data will be replaced!"
        read -p "Do you want to backup current data first? (y/N): " backup_first
        if [[ "$backup_first" =~ ^[Yy]$ ]]; then
            cmd_backup
            echo ""
        fi
    fi

    read -p "Restore this backup? (y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        print_info "Restore cancelled."
        exit 0
    fi

    # Remove existing and restore
    if [[ -d "$USERDATA_PATH" ]]; then
        rm -rf "$USERDATA_PATH"
    fi

    # Ensure parent directory exists
    mkdir -p "$(dirname "$USERDATA_PATH")"

    cp -r "$selected_backup" "$USERDATA_PATH"

    print_success "Restored from: $backup_name"
    print_info "User data location: $USERDATA_PATH"
}

# Show help
cmd_help() {
    echo ""
    echo "Quantum Forge Config Manager"
    echo "============================"
    echo ""
    echo "Manage user data for development and testing."
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  backup              Create a timestamped backup of user data"
    echo "  reset               Remove user data (prompts for confirmation)"
    echo "  reset --keep-sde    Reset but preserve the SDE (Static Data Export)"
    echo "  restore             List backups and restore a selected one"
    echo "  list                List available backups"
    echo "  help                Show this help message"
    echo ""
    echo "Paths:"
    echo "  User data:  $USERDATA_PATH"
    echo "  Backups:    $BACKUP_DIR"
    echo ""
}

# Main entry point
case "${1:-help}" in
    backup)
        cmd_backup
        ;;
    reset)
        shift
        cmd_reset "$@"
        ;;
    restore)
        cmd_restore
        ;;
    list)
        cmd_list
        ;;
    help|--help|-h)
        cmd_help
        ;;
    *)
        print_error "Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
