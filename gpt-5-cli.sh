#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# デフォルト（.env で上書き可能）
DEFAULT_MODEL_MAIN="gpt-5"
DEFAULT_MODEL_MINI="gpt-5-mini"
DEFAULT_MODEL_NANO="gpt-5-nano"
DEFAULT_EFFORT="low"
DEFAULT_VERBOSITY="low"

log() { printf "%s\n" "$*" >&2; }

LOG_STYLE_READY=false
LOG_COLOR_RESET=""
LOG_COLOR_MEDIUM=""
LOG_COLOR_HIGH=""

init_log_level_style() {
    if [ "${LOG_STYLE_READY:-false}" = true ]; then
        return
    fi

    LOG_STYLE_READY=true
    LOG_COLOR_RESET=""
    LOG_COLOR_MEDIUM=""
    LOG_COLOR_HIGH=""

    if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
        if command -v tput >/dev/null 2>&1 && tput colors >/dev/null 2>&1; then
            LOG_COLOR_RESET="$(tput sgr0)"
            LOG_COLOR_MEDIUM="$(tput setaf 3)"
            LOG_COLOR_HIGH="$(tput bold)$(tput setaf 1)"
        else
            LOG_COLOR_RESET=$'\033[0m'
            LOG_COLOR_MEDIUM=$'\033[33m'
            LOG_COLOR_HIGH=$'\033[1;31m'
        fi
    fi
}

decorate_level_value() {
    local value="$1"
    local level="$2"
    init_log_level_style

    local prefix="" suffix="${LOG_COLOR_RESET}" decorated="$value"

    case "$level" in
    medium)
        decorated="+${value}+"
        prefix="$LOG_COLOR_MEDIUM"
        ;;
    high)
        decorated="!${value}!"
        prefix="$LOG_COLOR_HIGH"
        ;;
    *)
        suffix=""
        ;;
    esac

    if [ -n "$prefix" ]; then
        decorated="${prefix}${decorated}${suffix}"
    fi

    printf '%s' "$decorated"
}

level_for_scale_value() {
    case "$1" in
    low | LOW)
        echo "low"
        ;;
    medium | MEDIUM)
        echo "medium"
        ;;
    high | HIGH)
        echo "high"
        ;;
    *)
        echo "high"
        ;;
    esac
}

level_for_model_value() {
    local value="$1"

    if [ -n "${MODEL_MAIN:-}" ] && [ "$value" = "$MODEL_MAIN" ]; then
        echo "high"
        return
    fi
    if [ -n "${MODEL_MINI:-}" ] && [ "$value" = "$MODEL_MINI" ]; then
        echo "medium"
        return
    fi
    if [ -n "${MODEL_NANO:-}" ] && [ "$value" = "$MODEL_NANO" ]; then
        echo "low"
        return
    fi

    case "$value" in
    *nano* | *lite* | *small*)
        echo "low"
        ;;
    *mini* | *base*)
        echo "medium"
        ;;
    *)
        echo "high"
        ;;
    esac
}

format_model_value() {
    local value="$1"
    local level
    level="$(level_for_model_value "$value")"
    decorate_level_value "$value" "$level"
}

format_scale_value() {
    local value="$1"
    local level
    level="$(level_for_scale_value "$value")"
    decorate_level_value "$value" "$level"
}

# システムプロンプト（任意）。存在すれば新規会話時に最初の system メッセージとして付与
SYSTEM_PROMPT_FILE="$SCRIPT_DIR/system_prompt.txt"
SYSTEM_PROMPT=""

# 依存コマンドの存在確認（挙動は変えないが早期にわかるように）
require_cmds() {
    for c in "$@"; do
        command -v "$c" >/dev/null 2>&1 || {
            echo "Error: required command not found: $c" >&2
            exit 1
        }
    done

    if [ "$OPERATION" = "compact" ]; then
        if ! [[ "$COMPACT_INDEX" =~ ^[0-9]+$ ]]; then
            echo "Error: --compact の履歴番号は正の整数で指定してください" >&2
            exit 1
        fi
        if [ ${#ARGS[@]} -ne 0 ]; then
            echo "Error: --compact とメッセージは同時に指定できません" >&2
            exit 1
        fi
        if [ "$CONTINUE" = true ] || [ "$RESUME_LIST_ONLY" = true ] || [ -n "${RESUME_INDEX:-}" ] || [ -n "${DELETE_INDEX:-}" ] || [ -n "${SHOW_INDEX:-}" ]; then
            echo "Error: --compact と他のフラグは併用できません" >&2
            exit 1
        fi
    fi

}

# .env 読込と環境変数反映
load_env() {
    if [ -f "$SCRIPT_DIR/.env" ]; then
        set -a
        # shellcheck disable=SC1090
        . "$SCRIPT_DIR/.env"
        set +a
    fi

    MODEL_MAIN="${OPENAI_MODEL_MAIN:-$DEFAULT_MODEL_MAIN}"
    MODEL_MINI="${OPENAI_MODEL_MINI:-$DEFAULT_MODEL_MINI}"
    MODEL_NANO="${OPENAI_MODEL_NANO:-$DEFAULT_MODEL_NANO}"
    EFFORT_DEFAULT="${OPENAI_DEFAULT_EFFORT:-$DEFAULT_EFFORT}"
    VERBOSITY_DEFAULT="${OPENAI_DEFAULT_VERBOSITY:-$DEFAULT_VERBOSITY}"

    if [ -z "${OPENAI_API_KEY:-}" ]; then
        echo "Error: OPENAI_API_KEY not found in .env file" >&2
        echo "Please set OPENAI_API_KEY in scripts/openai_api/.env" >&2
        exit 1
    fi

    # 履歴インデックスの保存先（.env の OPENAI_HISTORY_INDEX_FILE で上書き可能）
    local hist_path
    hist_path="${OPENAI_HISTORY_INDEX_FILE:-$HISTORY_INDEX_DEFAULT}"
    # 先頭の ~ を $HOME に展開（.env で引用されている場合に備える）
    if [ "${hist_path#~}" != "$hist_path" ]; then
        hist_path="${hist_path/#\~/$HOME}"
    fi
    HISTORY_INDEX_FILE="$hist_path"
    echo "[openai_api] history_index: $HISTORY_INDEX_FILE" >&2
}

load_system_prompt() {
    if [ -f "$SYSTEM_PROMPT_FILE" ]; then
        # 改行や引用符を含んでも jq --arg で安全にエスケープされる
        SYSTEM_PROMPT="$(cat "$SYSTEM_PROMPT_FILE")"
        # ログ（長文は出さず、文字数のみ）
        local n
        n=$(printf %s "$SYSTEM_PROMPT" | wc -c | awk '{print $1}')
        echo "[openai_api] system_prompt: loaded (${n} bytes)" >&2
    fi
}

show_help() {
    echo "Usage:"
    echo "  $0 [-i <image>] [flag] <input>"
    echo "  $0 --compact <num>"
    echo ""
    echo "flag（種類+数字／連結可／ハイフン必須）:"
    echo "  -m0/-m1/-m2 : model => nano/mini/main(${MODEL_NANO}/${MODEL_MINI}/${MODEL_MAIN})"
    echo "  -e0/-e1/-e2 : effort => low/medium/high (既定: ${EFFORT_DEFAULT})"
    echo "  -v0/-v1/-v2 : verbosity => low/medium/high (既定: ${VERBOSITY_DEFAULT})"
    echo "  -c          : continue（直前の会話から継続）"
    echo "  -r{num}     : 対応する履歴で対話を再開（例: -r2）"
    echo "  -d{num}     : 対応する履歴を削除（例: -d2）"
    echo "  -s{num}     : 対応する履歴の対話内容を表示（例: -s2）"
    echo ""
    echo "  -i <image>   : 入力に画像を添付（\$HOME 配下のフルパスまたは 'スクリーンショット *.png'）"
    echo ""
    echo "環境変数(.env):"
    echo "  OPENAI_HISTORY_INDEX_FILE : 履歴ファイルの保存先（例: ~/Library/Mobile Documents/com~apple~CloudDocs/gpt-5-cli/history_index.json）"
    echo ""
    echo "既定: model=${MODEL_NANO}, effort=${EFFORT_DEFAULT}, verbosity=${VERBOSITY_DEFAULT}（フラグ未指定時）"
    echo ""
    echo "例:"
    echo "  $0 -m1e2v2 もっと詳しく -> model=gpt-5-mini(m1), effort=high(e2), verbosity=high(v2)"
    echo "  $0 -m0e0v0 箇条書きで   -> model=gpt-5-nano(m0), effort=low(e0), verbosity=low(v0)"
    echo "  $0 -r                 -> 履歴一覧のみ表示して終了"
    echo "  $0 -r2 続きをやろう   -> 2番目の履歴を使って継続"
    echo "  $0 -d2               -> 2番目の履歴を削除して終了"
    echo "  $0 -s2               -> 2番目の履歴の対話全文を表示"
}

# =============================
# 履歴管理（history_index.json）
# =============================

HISTORY_INDEX_DEFAULT="$SCRIPT_DIR/history_index.json"
HISTORY_INDEX_FILE=""

init_history_index() {
    local dir
    dir="$(dirname "$HISTORY_INDEX_FILE")"
    mkdir -p "$dir"
    if [ ! -f "$HISTORY_INDEX_FILE" ]; then
        printf '[]' >"$HISTORY_INDEX_FILE"
    fi
}

get_latest_history_entry() {
    init_history_index
    local count
    count=$(jq 'length' "$HISTORY_INDEX_FILE" 2>/dev/null || echo 0)
    if [ "${count:-0}" -eq 0 ]; then
        return 1
    fi
    local latest
    latest=$(jq -c 'max_by(.updated_at // "")' "$HISTORY_INDEX_FILE")
    export LATEST_LAST_ID=$(jq -r '.last_response_id // empty' <<<"$latest")
    export LATEST_TITLE=$(jq -r '.title // empty' <<<"$latest")
    export LATEST_ENTRY_JSON="$latest"
    ACTIVE_ENTRY_JSON="$latest"
    ACTIVE_LAST_RESPONSE_ID=$(jq -r '.last_response_id // empty' <<<"$latest")
    [ -n "${LATEST_LAST_ID:-}" ]
}

list_history() {
    init_history_index
    local count
    count=$(jq 'length' "$HISTORY_INDEX_FILE" 2>/dev/null || echo 0)
    if [ "${count:-0}" -eq 0 ]; then
        echo "(履歴なし)"
        return 0
    fi

    echo "=== 履歴一覧（新しい順） ==="
    jq -r '
    sort_by(.updated_at // "") | reverse | to_entries[] |
    (.key+1|tostring) + "\t" +
    (.value.title // "(no title)") + "\t" +
    ((.value.model // "-") + "/" + (.value.effort // "-") + "/" + (.value.verbosity // "-") + " " + ((.value.request_count // 1)|tostring) + "回") + "\t" +
    (.value.updated_at // "-") + "\t" +
    (.value.last_response_id // "")
  ' "$HISTORY_INDEX_FILE" |
        awk -F '\t' '{printf "%2d) %s [%s] %s\n", $1, $2, $3, $4}'
}

select_history_by_number() {
    local sel="$1"
    init_history_index
    local count
    count=$(jq 'length' "$HISTORY_INDEX_FILE" 2>/dev/null || echo 0)
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || [ "$sel" -lt 1 ] || [ "$sel" -gt "$count" ]; then
        echo "[openai_api] 無効な履歴番号です（1〜$count）。: $sel" >&2
        exit 1
    fi
    local map_json idx selected_json
    map_json=$(jq -c 'sort_by(.updated_at // "") | reverse' "$HISTORY_INDEX_FILE")
    idx=$((sel - 1))
    # shellcheck disable=SC2155
    selected_json=$(jq -c --argjson i "$idx" '.[$i]' <<<"$map_json")
    export SELECTED_LAST_ID=$(jq -r '.last_response_id // empty' <<<"$selected_json")
    export SELECTED_TITLE=$(jq -r '.title // empty' <<<"$selected_json")
    export SELECTED_ENTRY_JSON="$selected_json"
    ACTIVE_ENTRY_JSON="$selected_json"
    ACTIVE_LAST_RESPONSE_ID=$(jq -r '.last_response_id // empty' <<<"$selected_json")
    if [ -z "${SELECTED_LAST_ID:-}" ]; then
        echo "[openai_api] 選択した履歴の last_response_id が無効です。" >&2
        exit 1
    fi
}

delete_history_by_number() {
    local sel="$1"
    init_history_index
    local count
    count=$(jq 'length' "$HISTORY_INDEX_FILE" 2>/dev/null || echo 0)
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || [ "$sel" -lt 1 ] || [ "$sel" -gt "$count" ]; then
        echo "[openai_api] 無効な履歴番号です（1〜$count）。: $sel" >&2
        exit 1
    fi
    local map_json idx selected_json sel_last_id sel_title
    map_json=$(jq -c 'sort_by(.updated_at // "") | reverse' "$HISTORY_INDEX_FILE")
    idx=$((sel - 1))
    selected_json=$(jq -c --argjson i "$idx" '.[$i]' <<<"$map_json")
    sel_last_id=$(jq -r '.last_response_id // empty' <<<"$selected_json")
    sel_title=$(jq -r '.title // "(no title)"' <<<"$selected_json")
    if [ -z "${sel_last_id:-}" ]; then
        echo "[openai_api] 選択した履歴の last_response_id が無効です。" >&2
        exit 1
    fi
    tmp_file="${HISTORY_INDEX_FILE}.tmp"
    jq -c --arg sel "$sel_last_id" 'map(select((.last_response_id // "") != $sel))' \
        "$HISTORY_INDEX_FILE" >"$tmp_file"
    mv "$tmp_file" "$HISTORY_INDEX_FILE"
    echo "削除しました: ${sel}) ${sel_title}"
}

# -s{num}: 指定履歴の対話内容を表示
show_history_by_number() {
    local sel="$1"
    init_history_index
    local count
    count=$(jq 'length' "$HISTORY_INDEX_FILE" 2>/dev/null || echo 0)
    if ! [[ "$sel" =~ ^[0-9]+$ ]] || [ "$sel" -lt 1 ] || [ "$sel" -gt "$count" ]; then
        echo "[openai_api] 無効な履歴番号です（1〜$count）。: $sel" >&2
        exit 1
    fi

    local map_json idx selected_json
    map_json=$(jq -c 'sort_by(.updated_at // "") | reverse' "$HISTORY_INDEX_FILE")
    idx=$((sel - 1))
    selected_json=$(jq -c --argjson i "$idx" '.[$i]' <<<"$map_json")

    local title updated_at rcnt
    title=$(jq -r '.title // "(no title)"' <<<"$selected_json")
    updated_at=$(jq -r '.updated_at // "-"' <<<"$selected_json")
    rcnt=$(jq -r '(.request_count // 0)|tostring' <<<"$selected_json")

    echo "=== 履歴 #$sel: ${title} (更新: ${updated_at}, リクエスト:${rcnt}回) ==="

    local has_turns
    has_turns=$(jq -r '(.turns // []) | length' <<<"$selected_json")
    if [ "${has_turns:-0}" -eq 0 ]; then
        echo "(この履歴には保存された対話メッセージがありません)"
        return 0
    fi

    # 着色設定（TTY かつ NO_COLOR 未設定時のみ色付け）
    local C_USER="" C_ASSIST="" C_SUMMARY="" C_RESET=""
    if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
        if tput colors >/dev/null 2>&1; then
            C_USER="$(tput setaf 6)"    # cyan
            C_ASSIST="$(tput setaf 4)"  # blue
            C_SUMMARY="$(tput setaf 3)" # yellow
            C_RESET="$(tput sgr0)"
        else
            C_USER=$'\033[36m'
            C_ASSIST=$'\033[34m'
            C_SUMMARY=$'\033[33m'
            C_RESET=$'\033[0m'
        fi
    fi

    # user/assistant のみを順に表示。本文はそのまま（複数行対応）
    jq -r --arg cu "$C_USER" --arg ca "$C_ASSIST" --arg cs "$C_SUMMARY" --arg cr "$C_RESET" '
      (.turns // [])
      | map(select((.role == "user") or (.role == "assistant") or (.role == "system" and (.kind // "") == "summary")))
      | .[]
      | (
          (if .role == "user" then ($cu + "user:" + $cr)
           elif .role == "assistant" then ($ca + "assistant:" + $cr)
           elif .role == "system" and (.kind // "") == "summary" then ($cs + "summary:" + $cr)
           else (.role + ":") end)
          + "\n" + ((.text // "")) + "\n"
        )
    ' <<<"$selected_json"
}

# =============================
# 引数解析と入力決定
# =============================

MODEL=""
EFFORT=""
VERBOSITY=""
OPERATION="ask"
COMPACT_INDEX=""
CONTINUE=false
RESUME_LIST_ONLY=false
RESUME_INDEX=""
HAS_EXPLICIT_HISTORY=false
DELETE_INDEX=""
SHOW_INDEX=""
ARGS=()
# 文脈（set -u 対策で初期化）
IS_NEW_CONVO=true
prev_response_id=""
prev_title=""
title_to_use=""
IMAGE_FILE=""
IMAGE_DATA_URL=""
IMAGE_MIME=""
RESUME_BASE_CONTEXT_JSON='[]'
RESUME_SUMMARY_TEXT=""
RESUME_SUMMARY_CREATED_AT=""
MODEL_EXPLICIT=false
EFFORT_EXPLICIT=false
VERBOSITY_EXPLICIT=false
ACTIVE_ENTRY_JSON=""
ACTIVE_LAST_RESPONSE_ID=""

resolve_image_path() {
    local raw="$1"
    local resolved

    if [[ "$raw" == /* ]]; then
        if [[ "$raw" != "$HOME/"* ]]; then
            echo "Error: -i で指定できるフルパスは $HOME 配下のみです: $raw" >&2
            exit 1
        fi
        resolved="$raw"
    elif [[ "$raw" == スクリーンショット* ]]; then
        if [[ "$raw" != *.png ]]; then
            echo "Error: 'スクリーンショット *.png' 形式の PNG のみ対応します: $raw" >&2
            exit 1
        fi
        resolved="$HOME/Desktop/$raw"
    else
        echo "Error: -i には $HOME 配下のフルパスか 'スクリーンショット *.png' のみ指定できます: $raw" >&2
        exit 1
    fi

    if [ ! -f "$resolved" ]; then
        echo "Error: 画像ファイルが見つかりません: $resolved" >&2
        exit 1
    fi

    printf '%s\n' "$resolved"
}

detect_image_mime() {
    local file_path="$1"
    local ext ext_lower
    ext="${file_path##*.}"
    ext_lower=$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')

    case "$ext_lower" in
    png)
        printf 'image/png\n'
        ;;
    jpg | jpeg)
        printf 'image/jpeg\n'
        ;;
    webp)
        printf 'image/webp\n'
        ;;
    gif)
        printf 'image/gif\n'
        ;;
    heic | heif)
        printf 'image/heic\n'
        ;;
    *)
        echo "Error: 未対応の画像拡張子です: $file_path" >&2
        exit 1
        ;;
    esac
}

prepare_image_payload() {
    if [ -z "${IMAGE_FILE:-}" ]; then
        return
    fi

    IMAGE_MIME="$(detect_image_mime "$IMAGE_FILE")"
    local b64
    b64=$(base64 <"$IMAGE_FILE" | tr -d '\n')
    if [ -z "$b64" ]; then
        echo "Error: 画像ファイルの base64 エンコードに失敗しました: $IMAGE_FILE" >&2
        exit 1
    fi
    IMAGE_DATA_URL="data:${IMAGE_MIME};base64,${b64}"
    echo "[openai_api] image_attached: $IMAGE_FILE ($IMAGE_MIME)" >&2
}

parse_args() {
    MODEL="$MODEL_NANO"
    EFFORT="$EFFORT_DEFAULT"
    VERBOSITY="$VERBOSITY_DEFAULT"
    MODEL_EXPLICIT=false
    EFFORT_EXPLICIT=false
    VERBOSITY_EXPLICIT=false

    set_model_index() {
        case "$1" in
        0) MODEL="$MODEL_NANO" ;;
        1) MODEL="$MODEL_MINI" ;;
        2) MODEL="$MODEL_MAIN" ;;
        *)
            echo "Invalid model index: -m$1 (use 0=nano,1=mini,2=main)" >&2
            exit 1
            ;;
        esac
        MODEL_EXPLICIT=true
    }

    set_effort_index() {
        case "$1" in
        0) EFFORT="low" ;;
        1) EFFORT="medium" ;;
        2) EFFORT="high" ;;
        *)
            echo "Invalid effort index: -e$1 (use 0=low,1=medium,2=high)" >&2
            exit 1
            ;;
        esac
        EFFORT_EXPLICIT=true
    }

    set_verbosity_index() {
        case "$1" in
        0) VERBOSITY="low" ;;
        1) VERBOSITY="medium" ;;
        2) VERBOSITY="high" ;;
        *)
            echo "Invalid verbosity index: -v$1 (use 0=low,1=medium,2=high)" >&2
            exit 1
            ;;
        esac
        VERBOSITY_EXPLICIT=true
    }

    while [ $# -gt 0 ]; do
        case "$1" in
        --help | -\?)
            show_help
            exit 0
            ;;
        --compact)
            if [ "$OPERATION" != "ask" ]; then
                echo "Error: --compact は複数回指定できません" >&2
                exit 1
            fi
            if [ $# -lt 2 ]; then
                echo "Error: --compact には履歴番号を指定してください" >&2
                exit 1
            fi
            OPERATION="compact"
            COMPACT_INDEX="$2"
            shift 2
            continue
            ;;
        -i)
            if [ $# -lt 2 ]; then
                echo "-i フラグには画像ファイルを指定してください" >&2
                exit 1
            fi
            if [ -n "${IMAGE_FILE:-}" ]; then
                echo "-i は複数回指定できません" >&2
                exit 1
            fi
            local raw_image_arg
            raw_image_arg="$2"
            IMAGE_FILE="$(resolve_image_path "$raw_image_arg")"
            shift 2
            continue
            ;;
        --)
            shift
            ARGS=("$@")
            break
            ;;
        -*)
            cluster="${1#-}"
            # クラスターフラグを左から順に読み取る
            i=0
            len=${#cluster}
            while [ $i -lt $len ]; do
                ch="${cluster:$i:1}"
                case "$ch" in
                m)
                    # 必須: 数字 0/1/2 を伴う
                    next="${cluster:$((i + 1)):1}"
                    if [[ "$next" =~ ^[0-2]$ ]]; then
                        set_model_index "$next"
                        i=$((i + 2))
                    else
                        echo "Invalid option: -m には 0/1/2 を続けてください（例: -m1）" >&2
                        exit 1
                    fi
                    ;;
                e)
                    # 必須: 数字 0/1/2 を伴う
                    next="${cluster:$((i + 1)):1}"
                    if [[ "$next" =~ ^[0-2]$ ]]; then
                        set_effort_index "$next"
                        i=$((i + 2))
                    else
                        echo "Invalid option: -e には 0/1/2 を続けてください（例: -e2）" >&2
                        exit 1
                    fi
                    ;;
                c)
                    CONTINUE=true
                    i=$((i + 1))
                    ;;
                r)
                    # -r{num} を解釈（{num} は1桁以上の数字）。なければ一覧表示のみ。
                    j=$((i + 1))
                    digits=""
                    while [ $j -lt $len ]; do
                        d="${cluster:$j:1}"
                        if [[ "$d" =~ ^[0-9]$ ]]; then
                            digits+="$d"
                            j=$((j + 1))
                        else
                            break
                        fi
                    done
                    if [ -n "$digits" ]; then
                        RESUME_INDEX="$digits"
                        CONTINUE=true
                        HAS_EXPLICIT_HISTORY=true
                        i=$j
                    else
                        RESUME_LIST_ONLY=true
                        i=$((i + 1))
                    fi
                    ;;
                d)
                    # -d{num}: 指定履歴を削除
                    j=$((i + 1))
                    digits=""
                    while [ $j -lt $len ]; do
                        d="${cluster:$j:1}"
                        if [[ "$d" =~ ^[0-9]$ ]]; then
                            digits+="$d"
                            j=$((j + 1))
                        else
                            break
                        fi
                    done
                    if [ -n "$digits" ]; then
                        DELETE_INDEX="$digits"
                        i=$j
                    else
                        RESUME_LIST_ONLY=true
                        i=$((i + 1))
                    fi
                    ;;
                s)
                    # -s{num}: 指定履歴の対話内容を表示
                    j=$((i + 1))
                    digits=""
                    while [ $j -lt $len ]; do
                        d="${cluster:$j:1}"
                        if [[ "$d" =~ ^[0-9]$ ]]; then
                            digits+="$d"
                            j=$((j + 1))
                        else
                            break
                        fi
                    done
                    if [ -n "$digits" ]; then
                        SHOW_INDEX="$digits"
                        i=$j
                    else
                        RESUME_LIST_ONLY=true
                        i=$((i + 1))
                    fi
                    ;;
                v)
                    next="${cluster:$((i + 1)):1}"
                    if [[ "$next" =~ ^[0-2]$ ]]; then
                        set_verbosity_index "$next"
                        i=$((i + 2))
                    else
                        echo "Invalid option: -v には 0/1/2 を続けてください（例: -v0）" >&2
                        exit 1
                    fi
                    ;;
                *)
                    echo "Invalid option: -$ch は無効です。-m0/1/2, -e0/1/2, -v0/1/2, -c, -r, -d/-d{num}, -s/-s{num} を使用してください。" >&2
                    exit 1
                    ;;
                esac
            done
            shift
            ;;
        *)
            ARGS=("$@")
            break
            ;;
        esac
    done
}

determine_input() {
    if [ -n "${DELETE_INDEX:-}" ]; then
        delete_history_by_number "$DELETE_INDEX"
        exit 0
    elif [ -n "${SHOW_INDEX:-}" ]; then
        show_history_by_number "$SHOW_INDEX"
        exit 0
    elif [ "$RESUME_LIST_ONLY" = true ]; then
        list_history
        exit 0
    elif [ -n "${RESUME_INDEX:-}" ]; then
        select_history_by_number "$RESUME_INDEX"
        prev_response_id="${SELECTED_LAST_ID}"
        prev_title="${SELECTED_TITLE:-}"
        title_to_use="$prev_title"
        if [ ${#ARGS[@]} -gt 0 ]; then
            INPUT_TEXT="${ARGS[*]}"
        else
            read -r -p "プロンプト > " INPUT_TEXT
            if [ -z "${INPUT_TEXT:-}" ]; then
                echo "プロンプトが空です。" >&2
                exit 1
            fi
        fi
    else
        if [ ${#ARGS[@]} -eq 0 ]; then
            show_help
            exit 1
        fi
        INPUT_TEXT="${ARGS[*]}"
    fi
}
build_compact_request() {
    local conversation_text="$1"

    local instruction="あなたは会話ログを要約するアシスタントです。論点を漏らさず日本語で簡潔にまとめてください。"
    local header="以下はこれまでの会話ログです。全てのメッセージを読んで要約に反映してください。"

    local user_prompt
    printf -v user_prompt '%s
---
%s
---

出力条件:
- 内容をシンプルに要約する
- 箇条書きでも短い段落でもよい' "$header" "$conversation_text"

    jq -n --arg m "$MODEL_MINI" --arg inst "$instruction" --arg prompt "$user_prompt" '{model:$m, reasoning:{effort:"medium"}, text:{verbosity:"medium"}, input:[{role:"system", content:[{type:"input_text", text:$inst}]},{role:"user", content:[{type:"input_text", text:$prompt}]}]}'
}

perform_compact() {
    select_history_by_number "$COMPACT_INDEX"

    local selected_json="${SELECTED_ENTRY_JSON:-}"
    if [ -z "$selected_json" ]; then
        echo "Error: 履歴を取得できませんでした" >&2
        exit 1
    fi

    local turn_count
    turn_count=$(jq '(.turns // []) | length' <<<"$selected_json")
    if [ "${turn_count:-0}" -eq 0 ]; then
        echo "Error: この履歴には要約対象のメッセージがありません" >&2
        exit 1
    fi

    local all_turns_json
    all_turns_json=$(jq -c '(.turns // [])' <<<"$selected_json")
    local summary_count
    summary_count=$(jq 'length' <<<"$all_turns_json")
    if [ "${summary_count:-0}" -eq 0 ]; then
        echo "Error: 要約対象のメッセージがありません" >&2
        exit 1
    fi

    local summary_source
    summary_source=$(jq -r '
        map((if .role == "user" then "ユーザー"
             elif .role == "assistant" then "アシスタント"
             elif .role == "system" and (.kind // "") == "summary" then "システム要約"
             else (.role // "不明") end)
             + ":
" + (.text // ""))
        | join("

---

")
    ' <<<"$all_turns_json")

    local request
    request=$(build_compact_request "$summary_source")

    local response summary_text
    response=$(call_api "$request")
    summary_text=$(echo "$response" | parse_response_text)

    if [ -z "${summary_text:-}" ] || [ "$summary_text" = "null" ]; then
        echo "Error: 要約の生成に失敗しました" >&2
        echo "Response: $response" >&2
        exit 1
    fi

    local ts_now
    ts_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    local summary_turn_json resume_json tmp_file
    summary_turn_json=$(jq -n --arg txt "$summary_text" --arg ts "$ts_now" '{role:"system", kind:"summary", text:$txt, at:$ts}')
    resume_json=$(jq -n --arg txt "$summary_text" --arg ts "$ts_now" '{mode:"new_request", previous_response_id:"", summary:{text:$txt, created_at:$ts}}')

    tmp_file="${HISTORY_INDEX_FILE}.tmp"
    jq -c --arg sel "$SELECTED_LAST_ID" --arg ts "$ts_now" --argjson resume "$resume_json" --argjson summary_turn "$summary_turn_json" '
        def apply_summary(x): x
          | .updated_at = $ts
          | .resume = $resume
          | .turns = [$summary_turn];
        map(if (.last_response_id // "") == $sel then apply_summary(.) else . end)
      ' "$HISTORY_INDEX_FILE" >"$tmp_file"
    mv "$tmp_file" "$HISTORY_INDEX_FILE"

    echo "[openai_api] compact: history=$COMPACT_INDEX, summarized=$summary_count" >&2

    printf '%s
' "$summary_text"
}

# =============================
# 会話コンテキストの確定（新規/継続、タイトル）
# =============================

compute_context() {
    # 明示的に履歴番号で選択していない継続（-c のみ等）の場合は直近履歴を採用
    if [ "$HAS_EXPLICIT_HISTORY" != true ] && [ "$CONTINUE" = true ]; then
        if get_latest_history_entry; then
            prev_response_id="$LATEST_LAST_ID"
            prev_title="$LATEST_TITLE"
        else
            echo "[openai_api] warn: 継続できる履歴が見つかりません（新規開始）。" >&2
        fi
    fi

    RESUME_BASE_CONTEXT_JSON='[]'
    RESUME_SUMMARY_TEXT=""
    RESUME_SUMMARY_CREATED_AT=""

    local resume_mode=""
    local resume_prev=""

    if [ -n "${ACTIVE_ENTRY_JSON:-}" ]; then
        if [ "$CONTINUE" = true ]; then
            local stored_model stored_effort stored_verbosity
            if [ "$MODEL_EXPLICIT" != true ]; then
                stored_model=$(jq -r '.model // empty' <<<"$ACTIVE_ENTRY_JSON")
                if [ -n "$stored_model" ] && [ "$stored_model" != "null" ]; then
                    MODEL="$stored_model"
                fi
            fi
            if [ "$EFFORT_EXPLICIT" != true ]; then
                stored_effort=$(jq -r '.effort // empty' <<<"$ACTIVE_ENTRY_JSON")
                if [ -n "$stored_effort" ] && [ "$stored_effort" != "null" ]; then
                    EFFORT="$stored_effort"
                fi
            fi
            if [ "$VERBOSITY_EXPLICIT" != true ]; then
                stored_verbosity=$(jq -r '.verbosity // empty' <<<"$ACTIVE_ENTRY_JSON")
                if [ -n "$stored_verbosity" ] && [ "$stored_verbosity" != "null" ]; then
                    VERBOSITY="$stored_verbosity"
                fi
            fi
        fi
        resume_mode=$(jq -r '.resume.mode // empty' <<<"$ACTIVE_ENTRY_JSON")
        resume_prev=$(jq -r '.resume.previous_response_id // empty' <<<"$ACTIVE_ENTRY_JSON")
        RESUME_SUMMARY_TEXT=$(jq -r '.resume.summary.text // empty' <<<"$ACTIVE_ENTRY_JSON")
        RESUME_SUMMARY_CREATED_AT=$(jq -r '.resume.summary.created_at // empty' <<<"$ACTIVE_ENTRY_JSON")

        if [ "$RESUME_SUMMARY_TEXT" = "null" ]; then
            RESUME_SUMMARY_TEXT=""
        fi
        if [ "$RESUME_SUMMARY_CREATED_AT" = "null" ]; then
            RESUME_SUMMARY_CREATED_AT=""
        fi

        if [ -n "$RESUME_SUMMARY_TEXT" ]; then
            RESUME_BASE_CONTEXT_JSON=$(jq -n --arg t "$RESUME_SUMMARY_TEXT" '[{role:"system", content:[{type:"input_text", text:$t}]}]')
        fi

        if [ -n "$resume_prev" ]; then
            prev_response_id="$resume_prev"
        fi

        if [ -z "${prev_title:-}" ]; then
            prev_title=$(jq -r '.title // empty' <<<"$ACTIVE_ENTRY_JSON")
        fi

        if [ "$resume_mode" = "new_request" ]; then
            prev_response_id=""
        fi
    fi

    IS_NEW_CONVO=true
    if [ "$CONTINUE" = true ]; then
        if [ -n "${prev_response_id:-}" ]; then
            IS_NEW_CONVO=false
        elif [ -n "${ACTIVE_ENTRY_JSON:-}" ] && [ "$resume_mode" = "new_request" ]; then
            IS_NEW_CONVO=false
        fi
    fi

    prev_title="${prev_title:-}"
    local title_candidate
    title_candidate=$(jq -rn --arg t "$INPUT_TEXT" '$t | gsub("[[:space:]]+";" ") | .[0:50]')
    if [ "$IS_NEW_CONVO" = true ]; then
        if [ "$CONTINUE" = true ] && [ -n "$prev_title" ]; then
            title_to_use="$prev_title"
        else
            title_to_use="$title_candidate"
        fi
    else
        title_to_use="$prev_title"
    fi
}

# =============================
# API 呼び出し
# =============================

build_request_json() {
    local log_model log_effort log_verbosity
    log_model="$(format_model_value "$MODEL")"
    log_effort="$(format_scale_value "$EFFORT")"
    log_verbosity="$(format_scale_value "$VERBOSITY")"

    {
        printf $'[openai_api] model=%s, effort=%s, verbosity=%s, continue=%s\n' "$log_model" "$log_effort" "$log_verbosity" "$CONTINUE"
        printf $'             resume_index=%s, resume_list_only=%s, delete_index=%s\n' "${RESUME_INDEX:-}" "${RESUME_LIST_ONLY:-false}" "${DELETE_INDEX:-}"
    } >&2
    if [ -n "${IMAGE_DATA_URL:-}" ]; then
        new_user_msg=$(jq -n --arg t "$INPUT_TEXT" --arg url "$IMAGE_DATA_URL" '{role:"user", content:[{type:"input_text", text:$t}, {type:"input_image", image_url:$url}]}')
    else
        new_user_msg=$(jq -n --arg t "$INPUT_TEXT" '{role:"user", content:[{type:"input_text", text:$t}]}')
    fi

    local input_json
    input_json='[]'

    if [ "$IS_NEW_CONVO" = true ] && [ -n "${SYSTEM_PROMPT:-}" ]; then
        local system_msg
        system_msg=$(jq -n --arg t "$SYSTEM_PROMPT" '{role:"system", content:[{type:"input_text", text:$t}]}')
        input_json=$(jq -n --argjson s "$system_msg" '[ $s ]')
    fi

    if [ -n "${RESUME_BASE_CONTEXT_JSON:-}" ] && [ "$RESUME_BASE_CONTEXT_JSON" != "[]" ]; then
        input_json=$(jq -n --argjson cur "$input_json" --argjson base "$RESUME_BASE_CONTEXT_JSON" '$cur + $base')
    fi

    input_json=$(jq -n --argjson cur "$input_json" --argjson u "$new_user_msg" '$cur + [$u]')

    request_json=$(jq -n --arg m "$MODEL" --arg e "$EFFORT" --arg v "$VERBOSITY" '{model:$m, reasoning:{effort:$e}, text:{verbosity:$v}, tools:[{type:"web_search_preview"}]}')
    request_json=$(echo "$request_json" | jq -c --argjson i "$input_json" '. + {input:$i}')

    if [ "$CONTINUE" = true ] && [ -n "$prev_response_id" ]; then
        request_json=$(echo "$request_json" | jq -c --arg pid "$prev_response_id" '. + {previous_response_id:$pid}')
    elif [ "$CONTINUE" = true ] && [ -z "$prev_response_id" ] && [ -z "${RESUME_SUMMARY_TEXT:-}" ]; then
        echo "[openai_api] warn: 直前の response.id が見つからないため、新規会話として開始します" >&2
    fi

    printf %s "$request_json"
}

call_api() {
    local req_json="$1"
    curl -sS https://api.openai.com/v1/responses \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $OPENAI_API_KEY" \
        -d "$req_json"
}

parse_response_text() {
    jq -r '
    ( .output_text? | if type=="array" then join("") elif type=="string" then . else empty end ) //
    ( .output[]? | select(.type=="message") | .content[0]?.text // empty ) //
    ( .output_message?.content[0]?.text // empty )
  ' 2>/dev/null
}

history_upsert() {
    local response_id="$1"
    local user_text="$2"
    local assistant_text="$3"
    init_history_index
    ts_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    local target_last_id="$prev_response_id"
    if [ -z "$target_last_id" ] && [ -n "${ACTIVE_LAST_RESPONSE_ID:-}" ]; then
        target_last_id="$ACTIVE_LAST_RESPONSE_ID"
    fi

    local resume_summary="${RESUME_SUMMARY_TEXT:-}"
    local resume_created="${RESUME_SUMMARY_CREATED_AT:-}"
    if [ -n "$resume_summary" ] && [ -z "$resume_created" ]; then
        resume_created="$ts_now"
    fi

    local resume_json
    if [ -n "$resume_summary" ]; then
        resume_json=$(jq -n --arg prev "$response_id" --arg text "$resume_summary" --arg created "$resume_created" '{mode:"response_id", previous_response_id:$prev, summary:{text:$text, created_at:$created}}')
    else
        resume_json=$(jq -n --arg prev "$response_id" '{mode:"response_id", previous_response_id:$prev}')
    fi

    if [ "$IS_NEW_CONVO" = true ] && [ -z "$target_last_id" ]; then
        jq -n --arg title "$title_to_use" --arg model "$MODEL" --arg effort "$EFFORT" --arg verbosity "$VERBOSITY" --arg id "$response_id" --arg ts "$ts_now" --arg u "$user_text" --arg a "$assistant_text" --argjson resume "$resume_json" '{title:$title, model:$model, effort:$effort, verbosity:$verbosity, created_at:$ts, updated_at:$ts, first_response_id:$id, last_response_id:$id, request_count:1, resume:$resume, turns:[ {role:"user", text:$u, at:$ts}, {role:"assistant", text:$a, at:$ts, response_id:$id} ] }' |
            jq -c --slurpfile cur "$HISTORY_INDEX_FILE" '$cur[0] + [.]' >"${HISTORY_INDEX_FILE}.tmp"
        mv "${HISTORY_INDEX_FILE}.tmp" "$HISTORY_INDEX_FILE"
        ACTIVE_LAST_RESPONSE_ID="$response_id"
        return
    fi

    jq -c --arg target "$target_last_id" --arg new "$response_id" --arg ts "$ts_now" --arg model "$MODEL" --arg effort "$EFFORT" --arg verbosity "$VERBOSITY" --arg u "$user_text" --arg a "$assistant_text" --arg resume_summary "$resume_summary" --arg resume_created "$resume_created" '
        def upd(x): x
          | .updated_at = $ts
          | .last_response_id = $new
          | .model = $model
          | .effort = $effort
          | .verbosity = $verbosity
          | .request_count = ((.request_count // 1) + 1)
          | .turns = ((.turns // []) + [ {role:"user", text:$u, at:$ts}, {role:"assistant", text:$a, at:$ts, response_id:$new} ])
          | .resume = (
              if ($resume_summary != "") then
                  ((.resume // {})
                    | .mode = "response_id"
                    | .previous_response_id = $new
                    | .summary = ((.summary // {})
                        | .text = $resume_summary
                        | .created_at = (if ($resume_created != "") then $resume_created else (.created_at // $ts) end)))
              else
                  ((.resume // {})
                    | .mode = "response_id"
                    | .previous_response_id = $new
                    | del(.summary))
              end
            );
        (map(if (.last_response_id // "") == $target then upd(.) else . end))
      ' "$HISTORY_INDEX_FILE" >"${HISTORY_INDEX_FILE}.tmp"

    if ! diff -q "$HISTORY_INDEX_FILE" "${HISTORY_INDEX_FILE}.tmp" >/dev/null 2>&1; then
        mv "${HISTORY_INDEX_FILE}.tmp" "$HISTORY_INDEX_FILE"
        ACTIVE_LAST_RESPONSE_ID="$response_id"
    else
        rm -f "${HISTORY_INDEX_FILE}.tmp"
        jq -n --arg title "$title_to_use" --arg model "$MODEL" --arg effort "$EFFORT" --arg verbosity "$VERBOSITY" --arg id "$response_id" --arg ts "$ts_now" --arg u "$user_text" --arg a "$assistant_text" --argjson resume "$resume_json" '{title:$title, model:$model, effort:$effort, verbosity:$verbosity, created_at:$ts, updated_at:$ts, first_response_id:$id, last_response_id:$id, request_count:1, resume:$resume,
              turns:[ {role:"user", text:$u, at:$ts}, {role:"assistant", text:$a, at:$ts, response_id:$id} ] }' |
            jq -c --slurpfile cur "$HISTORY_INDEX_FILE" '$cur[0] + [.]' >"${HISTORY_INDEX_FILE}.tmp"
        mv "${HISTORY_INDEX_FILE}.tmp" "$HISTORY_INDEX_FILE"
        ACTIVE_LAST_RESPONSE_ID="$response_id"
    fi
}

# =============================
# main
# =============================

main() {
    require_cmds jq curl awk diff base64
    load_env
    load_system_prompt
    parse_args "$@"

    if [ "$OPERATION" = "compact" ]; then
        perform_compact
        exit 0
    fi

    determine_input
    compute_context
    prepare_image_payload

    local req
    req=$(build_request_json)

    local response content response_id
    response=$(call_api "$req")
    content=$(echo "$response" | parse_response_text)

    if [ -z "${content:-}" ] || [ "$content" = "null" ]; then
        echo "Error: Failed to parse response or empty content" >&2
        echo "Response: $response" >&2
        exit 1
    fi

    response_id=$(echo "$response" | jq -r '.id // empty')
    if [ -n "$response_id" ] && [ "$response_id" != "null" ]; then
        history_upsert "$response_id" "$INPUT_TEXT" "$content"
    fi

    echo "$content"
}

main "$@"
