#!/bin/sh
# git filter-branch --msg-filter: English subjects for known release commits; preserve message body.
set -e
msg=$(cat)
rest=$(printf '%s' "$msg" | tail -n +2)

newsubj=""
case "$GIT_COMMIT" in
  fdad4911af0f0c23b4fbe89912ca2ff9832edab7) newsubj="chore: initial import of MF0-1984 (v0.0.1)" ;;
  822cb6c6bbb2ab88650c20223e5f9da38b2de8a4) printf '%s' "$msg"; exit 0 ;;
  b4d215553faf691e9e53c4ebc7a683575318d0b2) printf '%s' "$msg"; exit 0 ;;
  1d4e1ff5acf3a9a59a36e04654e40e87befaa969) newsubj="Version 1.1.0: Memory tree, themes, UI and copy tweaks" ;;
  0d23dbaa2dbbe8d3690979ea8a0674d660c1be21) newsubj="Version 1.2.0: SQLite API, themes and dialogs, theme deletion, context pipeline, PM2/Vite, Cursor rules" ;;
  4011e1f7a159079ce3620551323c505cfecb20f6) newsubj="Version 1.3.0: pinned themes, rename flow, local-time dates, API/UI fixes" ;;
  76b072dc123ab216f304ddf42e2c9f164d44a8c7) newsubj="Version 1.4.0: favorite replies (API + star), footnotes/citations, Favorites panel, copy images from favorites, chat and API fixes" ;;
  cb9a2dc5ce7eae5ac24f1bd1603051c588695017) newsubj="Release 1.5.0: chat attachments, Gemini/OpenAI images, Memory tree UI, Activity/Favorites panels" ;;
  1b9161df0121d8a92d1599e4035c75dcd406f295) newsubj="Release 1.6.1: per-model analytics, DB migrations, UI and API fixes" ;;
  531ef31e8d72f92f75a2cb3bdcfdb5a73f630299) newsubj="Release 1.6.2: Intro PIN (database, modals), lock and modal UI fixes" ;;
  f9517c44642f5377a433fb390b8a60498439d123) newsubj="Release 1.6.3: separate PINs for Intro/Rules/Access, ir-panel-lock API, lock icon click fix" ;;
  63c38e5ea84b6f71cef0524147b2695092020192) newsubj="Release MF0-1984 v1.6.5: Access #data mode, analytics, snapshot API, UI fixes" ;;
  ba9e83e2b1f081dfa4cadf0b3ec6a6f3240ca224) newsubj="Version 1.6.6: reply regeneration (Reply #N), clone-turn API, thread grouping" ;;
  32c604dca6d285f1122fea3fb9cc2c793ede4fab) newsubj="Version 1.6.8: no Search in header; Rules/Access text-only (no + menu or file drop)" ;;
  e9aa5dfb67070ebeb268357bc58fc29468fc36a0) newsubj="Version 1.6.9: usage archive, Rules session, Intro/Rules/Access clear flows, Access copy and inline code in informer" ;;
  d1c191173f83eab12c266cde0273cffec4931595) newsubj="Release 1.7.0: Intro/Rules keepers and API, user profile in model context, max_completion_tokens for OpenAI, UI fixes" ;;
  *) printf '%s' "$msg"; exit 0 ;;
esac

if [ -n "$rest" ]; then
  printf '%s\n\n%s' "$newsubj" "$rest"
else
  printf '%s\n' "$newsubj"
fi
