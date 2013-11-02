
#Note: if you edit this file on Windows OS, please be sure to use
#unix style new line code, i mean 0xA (LF). Do not save 0xD 0xA!

log() {
    echo $* >&2
}

log "------------------- `date` ----------------------"
cd ${0}_ || exit 1  #cd run.sh_ sub directory

FEED_FPS="$1"; shift || exit 1  #first argument as frames_per_second
FFMPEG_FPS="$1"; shift || exit 1  #second argument as frames_per_second
FFMPEG_OUTPUT="$@" #get all other arguments from third argument

#set file as executable
chmod 755 * | exit 1

log "test get-raw-image version"

{ GET_RAW_IMG_EXEC_FILE="./get-raw-image-4.1.2"; log "trying $GET_RAW_IMG_EXEC_FILE"; IMG_FORMAT=`$GET_RAW_IMG_EXEC_FILE`; } || \
{ GET_RAW_IMG_EXEC_FILE="./get-raw-image-4"    ; log "trying $GET_RAW_IMG_EXEC_FILE"; IMG_FORMAT=`$GET_RAW_IMG_EXEC_FILE`; } || \
{ GET_RAW_IMG_EXEC_FILE="./get-raw-image-old"  ; log "trying $GET_RAW_IMG_EXEC_FILE"; IMG_FORMAT=`$GET_RAW_IMG_EXEC_FILE`; } || \
{ log "Failed to test get-raw-image and get image format"; exit 1; }

log "use GET_RAW_IMG_EXEC_FILE: $GET_RAW_IMG_EXEC_FILE"
log "use imageformat: $IMG_FORMAT"

log "test ffmpeg cpu version"
{ FFMPEG_EXEC_FILE="./ffmpeg.armv7"; log "trying $FFMPEG_EXEC_FILE"; FFMPEG_VER=`$FFMPEG_EXEC_FILE -version`; } || \
{ FFMPEG_EXEC_FILE="./ffmpeg.armv5"; log "trying $FFMPEG_EXEC_FILE"; FFMPEG_VER=`$FFMPEG_EXEC_FILE -version`; } || \
{ log "Failed test load ffmpeg"; exit 1; }

log "use FFMPEG_EXEC_FILE: $FFMPEG_EXEC_FILE"

FFMPEG_INPUT="-f rawvideo $IMG_FORMAT -r $FFMPEG_FPS -i -"  #intput from stdin
FFMPEG_CMDLINE="$FFMPEG_EXEC_FILE $FFMPEG_INPUT $FFMPEG_OUTPUT"

log "****exec: $GET_RAW_IMG_EXEC_FILE $FEED_FPS | $FFMPEG_CMDLINE" 
$GET_RAW_IMG_EXEC_FILE $FEED_FPS | $FFMPEG_CMDLINE
