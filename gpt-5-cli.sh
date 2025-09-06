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
    echo "Usage: $0 [-<クラスタ>] <入力テキスト>"
    echo ""
    echo "フラグ（種類+数字／連結可／ハイフン必須）:"
    echo "  -m0/-m1/-m2 : model => nano/mini/main(${MODEL_NANO}/${MODEL_MINI}/${MODEL_MAIN})"
    echo "  -e0/-e1/-e2 : effort => low/medium/high (既定: ${EFFORT_DEFAULT})"
    echo "  -v0/-v1/-v2 : verbosity => low/medium/high (既定: ${VERBOSITY_DEFAULT})"
    echo "  -c          : continue（直前の会話から継続）"
    echo "  -r          : 履歴一覧を表示して終了（表示のみ）"
    echo "  -r{num}     : 対応する履歴で対話を再開（例: -r2）"
    echo "  -d{num}     : 対応する履歴を削除（例: -d2）"
    echo "  -s{num}     : 対応する履歴の対話内容を表示（例: -s2）"
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
    local C_USER="" C_ASSIST="" C_RESET=""
    if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
        if tput colors >/dev/null 2>&1; then
            C_USER="$(tput setaf 6)"   # cyan
            C_ASSIST="$(tput setaf 4)" # blue
            C_RESET="$(tput sgr0)"
        else
            C_USER=$'\033[36m'
            C_ASSIST=$'\033[34m'
            C_RESET=$'\033[0m'
        fi
    fi

    # user/assistant のみを順に表示。本文はそのまま（複数行対応）
    jq -r --arg cu "$C_USER" --arg ca "$C_ASSIST" --arg cr "$C_RESET" '
      (.turns // [])
      | map(select(.role == "user" or .role == "assistant"))
      | .[]
      | (
          (if .role == "user" then ($cu + "user:" + $cr) else ($ca + "assistant:" + $cr) end)
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

parse_args() {
    # 事前スキャン（互換のための名残; 実処理では未使用）
    PRESCAN_RESUME=false
    for __a in "$@"; do
        case "$__a" in
        -*) [[ "$__a" == *r* ]] && PRESCAN_RESUME=true ;;
        esac
    done

    MODEL="$MODEL_NANO"
    EFFORT="$EFFORT_DEFAULT"
    VERBOSITY="$VERBOSITY_DEFAULT"

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
    }

    while [ $# -gt 0 ]; do
        case "$1" in
        --help | -\?)
            show_help
            exit 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            cluster="${1#-}"
            # 新方式/旧方式の混在クラスタを左から順に読み取る
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
                        echo "Invalid option: -d は -d{num} の形式で指定してください（例: -d2）。" >&2
                        exit 1
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
                        echo "Invalid option: -s は -s{num} の形式で指定してください（例: -s2）。" >&2
                        exit 1
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
                    echo "Invalid option: -$ch は無効です。旧方式（-5/-m/-n/h/e/l）は廃止しました。-m0/1/2, -e0/1/2, -c, -r を使用してください。" >&2
                    exit 1
                    ;;
                esac
            done
            shift
            ;;
        *)
            ARGS+=("$1")
            shift
            ARGS+=("$@")
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

    # 新規/継続の判定
    IS_NEW_CONVO=true
    if [ "$CONTINUE" = true ] && [ -n "${prev_response_id:-}" ]; then
        IS_NEW_CONVO=false
    fi

    # タイトル決定
    prev_title="${prev_title:-}"
    local title_candidate
    title_candidate=$(jq -rn --arg t "$INPUT_TEXT" '$t | gsub("\\s+";" ") | .[0:50]')
    if [ "$IS_NEW_CONVO" = true ]; then
        title_to_use="$title_candidate"
    else
        title_to_use="$prev_title"
    fi
}

# =============================
# API 呼び出し
# =============================

build_request_json() {
    # パラメータログ（minimal 廃止に伴い api 表記を削除）
    {
        printf '[openai_api] model=%s, effort=%s, verbosity=%s, continue=%s, resume_index=%s, resume_list_only=%s, delete_index=%s\n' \
            "$MODEL" "$EFFORT" "$VERBOSITY" "$CONTINUE" "${RESUME_INDEX:-}" "${RESUME_LIST_ONLY:-false}" "${DELETE_INDEX:-}"
    } >&2

    # 入力メッセージ
    new_user_msg=$(jq -n --arg t "$INPUT_TEXT" '{role:"user", content:[{type:"input_text", text:$t}]}')
    if [ "$IS_NEW_CONVO" = true ] && [ -n "${SYSTEM_PROMPT:-}" ]; then
        system_msg=$(jq -n --arg t "$SYSTEM_PROMPT" '{role:"system", content:[{type:"input_text", text:$t}]}')
        input_json=$(jq -n -c --argjson s "$system_msg" --argjson u "$new_user_msg" '[$s,$u]')
    else
        input_json=$(jq -n -c --argjson u "$new_user_msg" '[$u]')
    fi

    # リクエスト JSON
    request_json=$(jq -n \
        --arg m "$MODEL" \
        --arg e "$EFFORT" \
        --arg v "$VERBOSITY" \
        '{model:$m, reasoning:{effort:$e}, text:{verbosity:$v}, tools:[{type:"web_search_preview"}]}')
    request_json=$(echo "$request_json" | jq -c --argjson i "$input_json" '. + {input:$i}')

    if [ "$CONTINUE" = true ] && [ -n "$prev_response_id" ]; then
        request_json=$(echo "$request_json" | jq -c --arg pid "$prev_response_id" '. + {previous_response_id:$pid}')
    elif [ "$CONTINUE" = true ] && [ -z "$prev_response_id" ]; then
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
    if [ "$IS_NEW_CONVO" = true ]; then
        jq -n --arg title "$title_to_use" --arg model "$MODEL" --arg effort "$EFFORT" --arg verbosity "$VERBOSITY" \
            --arg id "$response_id" --arg ts "$ts_now" --arg u "$user_text" --arg a "$assistant_text" '{title:$title, model:$model, effort:$effort, verbosity:$verbosity, created_at:$ts, updated_at:$ts, first_response_id:$id, last_response_id:$id, request_count:1, turns:[ {role:"user", text:$u, at:$ts}, {role:"assistant", text:$a, at:$ts, response_id:$id} ] }' |
            jq -c --slurpfile cur "$HISTORY_INDEX_FILE" '$cur[0] + [.]' >"${HISTORY_INDEX_FILE}.tmp"
        mv "${HISTORY_INDEX_FILE}.tmp" "$HISTORY_INDEX_FILE"
    else
        jq -c \
            --arg prev "${prev_response_id:-}" \
            --arg new "$response_id" \
            --arg ts "$ts_now" \
            --arg model "$MODEL" \
            --arg effort "$EFFORT" \
            --arg verbosity "$VERBOSITY" \
            --arg u "$user_text" \
            --arg a "$assistant_text" \
            '
        def upd(x): x
          | .updated_at = $ts
          | .last_response_id = $new
          | .model = $model
          | .effort = $effort
          | .verbosity = $verbosity
          | .request_count = ((.request_count // 1) + 1)
          | .turns = ((.turns // []) + [ {role:"user", text:$u, at:$ts}, {role:"assistant", text:$a, at:$ts, response_id:$new} ]);
        (map(if (.last_response_id // "") == $prev then upd(.) else . end))
      ' "$HISTORY_INDEX_FILE" >"${HISTORY_INDEX_FILE}.tmp"

        if ! diff -q "$HISTORY_INDEX_FILE" "${HISTORY_INDEX_FILE}.tmp" >/dev/null 2>&1; then
            mv "${HISTORY_INDEX_FILE}.tmp" "$HISTORY_INDEX_FILE"
        else
            rm -f "${HISTORY_INDEX_FILE}.tmp"
            jq -n --arg title "$title_to_use" --arg model "$MODEL" --arg effort "$EFFORT" --arg verbosity "$VERBOSITY" \
                --arg id "$response_id" --arg ts "$ts_now" --arg u "$user_text" --arg a "$assistant_text" \
                '{title:$title, model:$model, effort:$effort, verbosity:$verbosity, created_at:$ts, updated_at:$ts, first_response_id:$id, last_response_id:$id, request_count:1,
                  turns:[ {role:"user", text:$u, at:$ts}, {role:"assistant", text:$a, at:$ts, response_id:$id} ] }' |
                jq -c --slurpfile cur "$HISTORY_INDEX_FILE" '$cur[0] + [.]' >"${HISTORY_INDEX_FILE}.tmp"
            mv "${HISTORY_INDEX_FILE}.tmp" "$HISTORY_INDEX_FILE"
        fi
    fi
}

# =============================
# main
# =============================

main() {
    require_cmds jq curl awk diff
    load_env
    load_system_prompt
    parse_args "$@"
    determine_input
    compute_context

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
