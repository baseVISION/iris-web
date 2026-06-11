import crc32 from '$lib/utils/crc32';

var session_id = null ;
var collaborator = null ;
var buffer_dumped = false ;
var last_applied_change = null ;
var just_cleared_buffer = null ;
var from_sync = null;

// --- Milkdown (WYSIWYG) editor state -------------------------------------------------
// GUI mode is single-editor: it cannot consume the ACE per-keystroke collaboration
// deltas, so it is disabled while another collaborator is actively editing. Saves go
// through the same CRC32-checked /case/summary/update path as the ACE editor.
let summary_gui_mode = false;            // true when Milkdown is active instead of ACE
let summary_editor_switching = false;    // guards against concurrent toggles
let summary_applying_remote = false;     // true while loading remote content into Milkdown
let summary_gui_save_timer = null;       // debounce timer for GUI autosave
let summary_collab_active_until = 0;     // epoch ms; a collaborator is "active" while now < this
let summary_gui_dirty = false;           // true once the user actually edits in GUI (since open/save)
let summary_last_gui_md = null;          // last-known GUI markdown (fallback while Milkdown re-creates)
let summary_gui_baseline = null;         // normalized markdown right after (re)create; edits are
                                         // only "real" when they diverge from this (filters the
                                         // initial Crepe normalization markdownUpdated event)
let summary_gui_settling = false;        // true for a short window after (re)create while Crepe
                                         // normalizes async; updates then refresh the baseline
                                         // instead of marking the doc dirty
const SUMMARY_GUI_SETTLE_MS = 500;
const SUMMARY_COLLAB_WINDOW_MS = 15000;  // how long a remote edit keeps the GUI disabled

var editor = ace.edit("editor_summary",
    {
    autoScrollEditorIntoView: true,
    minLines: 4
    });

var textarea = $('#case_summary');

function Collaborator( session_id ) {
    this.collaboration_socket = io.connect() ;

    this.channel = "case-" + session_id;
    this.collaboration_socket.emit('join', { 'channel': this.channel });

    this.collaboration_socket.on( "change", function(data) {
        delta = JSON.parse( data.delta ) ;
        console.log(delta);
        last_applied_change = delta ;
        // A remote user is editing: keep the hidden ACE session in sync and mark a
        // collaboration window so GUI mode stays disabled / its autosave is suppressed
        // (Milkdown cannot apply these per-keystroke deltas).
        summary_collab_active_until = Date.now() + SUMMARY_COLLAB_WINDOW_MS;
        // Cancel any queued GUI autosave so it can't fire into the collaborator's live edit.
        if (summary_gui_save_timer) { clearTimeout(summary_gui_save_timer); summary_gui_save_timer = null; }
        $("#content_typing").text(data.last_change + " is typing..");
        editor.getSession().getDocument().applyDeltas( [delta] ) ;
    }.bind() ) ;

    this.collaboration_socket.on( "clear_buffer", function() {
        just_cleared_buffer = true ;
        console.log( "setting editor empty" ) ;
        editor.setValue( "" ) ;
    }.bind() ) ;

    this.collaboration_socket.on( "save", function(data) {
        $("#content_last_saved_by").text("Last saved by " + data.last_saved);
         sync_editor(true);
    }.bind() ) ;
}

Collaborator.prototype.change = function( delta ) {
    this.collaboration_socket.emit( "change", { 'delta': delta, 'channel': this.channel } ) ;
}

Collaborator.prototype.clear_buffer = function() {
    this.collaboration_socket.emit( "clear_buffer", { 'channel': this.channel } ) ;
}

Collaborator.prototype.save = function() {
    this.collaboration_socket.emit( "save", { 'channel': this.channel } ) ;
}

function body_loaded() {

    collaborator = new Collaborator( get_caseid() ) ;

    // registering change callback
    from_sync = true;
    editor.on( "change", function( e ) {
        // TODO, we could make things more efficient and not likely to conflict by keeping track of change IDs
        if( last_applied_change!=e && editor.curOp && editor.curOp.command.name) {
            collaborator.change( JSON.stringify(e) ) ;
        }
    }, false );

    editor.$blockScrolling = Infinity ;

    document.getElementsByTagName('textarea')[0].focus() ;
    last_applied_change = null ;
    just_cleared_buffer = false ;
}

function handle_ed_paste(event) {
    filename = null;
    const { items } = event.originalEvent.clipboardData;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];

      if (item.kind === 'string') {
        item.getAsString(function (s){
            filename = $.trim(s.replace(/\t|\n|\r/g, '')).substring(0, 40);
        });
      }

      if (item.kind === 'file') {
        const blob = item.getAsFile();

        if (blob !== null) {
            const reader = new FileReader();
            reader.onload = (e) => {
                notify_success('The file is uploading in background. Don\'t leave the page');

                if (filename === null) {
                    let ext = get_extension_from_mime(blob.type);
                    filename = random_filename(25) + '.' + ext;
                }

                upload_interactive_data(e.target.result, filename, function(data){
                    url = data.data.file_url + case_param();
                    event.preventDefault();
                    editor.insertSnippet(`\n![${filename}](${url} =40%x40%)\n`);
                });

            };
            reader.readAsDataURL(blob);
        } else {
            notify_error('Unsupported direct paste of this item. Use datastore to upload.');
        }
      }
    }
}

function report_template_selector() {
    $('#modal_select_report').modal({ show: true });
}

function gen_report(safe) {
    url = '/case/report/generate-investigation/' + $("#select_report option:selected").val() + case_param();
    if (safe === true) {
        url += '&safe=true';
    }
    window.open(url, '_blank');
}

function gen_act_report(safe) {
    url = '/case/report/generate-activities/' + $("#select_report_act option:selected").val() + case_param();
    if (safe === true) {
        url += '&safe=true';
    }
    window.open(url, '_blank');
}

function act_report_template_selector() {
    $('#modal_select_report_act').modal({ show: true });
}

function edit_case_summary() {
    $('#container_editor_summary').toggle();
    if ($('#container_editor_summary').is(':visible')) {
        $('#ctrd_casesum').removeClass('col-md-12').addClass('col-md-6');
        $('#summary_edition_btn').show(100);
        $("#sum_refresh_btn").html('Save');
        $("#sum_edit_btn").html('Close editor');
        $('#sum_toggle_gui').show();
    } else {
        // Leaving the editor: if Milkdown is active, sync its content into ACE, tear it
        // down, and always flush a save. sync_editor() de-dupes via CRC32, so an unchanged
        // summary produces no POST; this guarantees edits persist regardless of timing.
        if (summary_gui_mode) {
            restore_summary_ace_view();
            sync_editor(false);
        }
        $('#ctrd_casesum').removeClass('col-md-6').addClass('col-md-12');
        $('#summary_edition_btn').hide();
        $('#sum_toggle_gui').hide();
        $("#sum_refresh_btn").html('Refresh');
        $("#sum_edit_btn").html('Edit');
    }
}

/* Apply remote summary content to whichever editor is active.
   Returns true if the content was applied, false if it was deliberately NOT applied
   (e.g. unsaved GUI edits would be lost — caller must then keep the local CRC baseline so
   the next save is treated as a conflict rather than a silent overwrite).
   Pass force=true to apply over local GUI edits (used when the user accepts remote in a
   conflict prompt). */
function apply_remote_summary(md, force) {
    if (summary_gui_mode && window.IrisMilkdown && window.IrisMilkdown.isActive()) {
        if (summary_gui_dirty && !force) {
            // A remote change arrived while we have unsaved GUI edits — do NOT destroy them.
            notify_error('This summary was just changed by someone else. Your unsaved changes are kept — switch to the Markdown editor to reconcile, then save.');
            return false;
        }
        // Reload the WYSIWYG editor with the remote content (guarded so the reload does
        // not fire the autosave change handler).
        summary_applying_remote = true;
        summary_gui_dirty = false;
        summary_last_gui_md = md || '';
        window.IrisMilkdown.create('#milkdown_root_summary', md || '', on_summary_gui_change)
            .then(() => {
                summary_applying_remote = false;
                begin_gui_settle();
            })
            .catch(() => { summary_applying_remote = false; });
        return true;
    }
    from_sync = true;
    editor.getSession().setValue(md || '');
    return true;
}

/* Returns the current summary markdown from whichever editor is active (ACE or Milkdown). */
function get_active_summary_markdown() {
    if (summary_gui_mode) {
        if (window.IrisMilkdown && window.IrisMilkdown.isActive()) {
            let md = window.IrisMilkdown.getMarkdown();
            if (md !== null && md !== undefined) {
                summary_last_gui_md = md;
                return md;
            }
        }
        // Milkdown is mid-(re)create: use the last-known GUI markdown rather than the
        // stale (hidden) ACE content, which would otherwise be persisted by accident.
        if (summary_last_gui_md !== null) {
            return summary_last_gui_md;
        }
    }
    return editor.getSession().getValue();
}

/* Start a short "settle" window after (re)creating Milkdown: during it, content updates are
   treated as Crepe's own normalization (they refresh the baseline) rather than user edits.
   When it ends, the baseline is frozen to the fully-normalized content. */
function begin_gui_settle() {
    summary_gui_settling = true;
    summary_gui_dirty = false;
    try { summary_gui_baseline = window.IrisMilkdown.getMarkdown(); summary_last_gui_md = summary_gui_baseline; } catch (e) { /* noop */ }
    setTimeout(function () {
        try { summary_gui_baseline = window.IrisMilkdown.getMarkdown(); } catch (e) { /* noop */ }
        summary_gui_settling = false;
    }, SUMMARY_GUI_SETTLE_MS);
}

/* Debounced autosave fired by Milkdown edits. */
function on_summary_gui_change() {
    if (summary_applying_remote) { return; }
    let cur = null;
    try { cur = window.IrisMilkdown.getMarkdown(); } catch (e) { /* noop */ }
    if (cur !== null) { summary_last_gui_md = cur; }
    if (summary_gui_settling) {
        // Crepe is still normalizing right after (re)create — keep the baseline current
        // rather than treating its own normalization as a user edit.
        if (cur !== null) { summary_gui_baseline = cur; }
        return;
    }
    // Ignore serialization-only churn: only a real divergence from the baseline is an edit.
    if (cur !== null && cur === summary_gui_baseline) { return; }
    summary_gui_dirty = true;
    // Don't autosave over a live collaborator's edits — Milkdown can't merge their deltas.
    if (Date.now() < summary_collab_active_until) {
        $('#last_saved').text('Not saved (others editing)').addClass('badge-danger').removeClass('badge-success');
        return;
    }
    $('#last_saved').text('Changes not saved').addClass('badge-danger').removeClass('badge-success');
    if (summary_gui_save_timer) { clearTimeout(summary_gui_save_timer); }
    summary_gui_save_timer = setTimeout(function () {
        summary_gui_save_timer = null;
        // Re-check at fire time: a collaborator may have started editing since we scheduled.
        if (Date.now() < summary_collab_active_until) {
            $('#last_saved').text('Not saved (others editing)').addClass('badge-danger').removeClass('badge-success');
            return;
        }
        sync_editor(false);
    }, 2000);
}

/* Tear down Milkdown and restore the default ACE split layout, ALWAYS copying Milkdown's
   current markdown back into ACE first so the two never diverge. The caller then flushes a
   save via sync_editor(), whose CRC32 check skips a POST when nothing actually changed (so a
   no-edit open/close yields at most a one-time, idempotent normalisation, never data loss).
   Returns whether there were unsaved GUI edits (informational; callers no longer gate on it). */
function restore_summary_ace_view() {
    if (summary_gui_save_timer) { clearTimeout(summary_gui_save_timer); summary_gui_save_timer = null; }
    let was_dirty = summary_gui_dirty;
    let md = (window.IrisMilkdown && window.IrisMilkdown.isActive())
        ? window.IrisMilkdown.getMarkdown() : summary_last_gui_md;
    if (window.IrisMilkdown) { window.IrisMilkdown.destroy(); }
    $('#milkdown_container_summary').hide();
    $('#container_editor_summary').removeClass('col-md-12').addClass('col-md-6');
    $('#editor_summary').show();
    $('#summary_edition_btn').show();
    $('#ctrd_casesum').show();
    summary_gui_mode = false;
    summary_gui_dirty = false;
    summary_last_gui_md = null;
    summary_gui_baseline = null;
    summary_gui_settling = false;
    if (md !== null && md !== undefined) {
        from_sync = true;
        editor.getSession().setValue(md);
    }
    $('#sum_toggle_gui').prop('disabled', false)
        .html('<i class="fa-solid fa-pen-fancy"></i> GUI')
        .removeClass('btn-primary').addClass('btn-light')
        .attr('title', 'Switch to GUI (WYSIWYG) editor');
    return was_dirty;
}

/* Toggle between the ACE markdown editor (default) and the Milkdown WYSIWYG editor. */
async function toggle_summary_editor_mode() {
    if (typeof window.IrisMilkdown === 'undefined') {
        notify_error('GUI editor is still loading, please retry in a moment.');
        return;
    }
    if (summary_editor_switching) { return; }

    if (!summary_gui_mode) {
        // Block GUI while a collaborator is actively editing (real-time sync is ACE-only).
        if (Date.now() < summary_collab_active_until) {
            notify_error('The GUI editor is disabled while others are editing this summary. Use the Markdown editor for collaborative editing.');
            return;
        }
        summary_editor_switching = true;
        $('#sum_toggle_gui').prop('disabled', true);
        let md = editor.getSession().getValue();
        try {
            summary_applying_remote = true;
            summary_gui_dirty = false;          // fresh open: not dirty until the user edits
            summary_last_gui_md = md;
            await window.IrisMilkdown.create('#milkdown_root_summary', md, on_summary_gui_change);
            summary_applying_remote = false;
            begin_gui_settle();   // ignore initial normalization; freeze baseline after settle
            // Flip the UI only once Crepe is fully created.
            $('#editor_summary').hide();
            $('#summary_edition_btn').hide();
            $('#ctrd_casesum').hide();           // Milkdown is itself the live view
            $('#container_editor_summary').removeClass('col-md-6').addClass('col-md-12');
            $('#milkdown_container_summary').show();
            summary_gui_mode = true;
            $('#sum_toggle_gui')
                .html('<i class="fa-solid fa-code"></i> Markdown')
                .addClass('btn-primary').removeClass('btn-light')
                .attr('title', 'Switch to Markdown editor');
        } catch (e) {
            summary_applying_remote = false;
            notify_error('Failed to open the GUI editor: ' + (e && e.message ? e.message : e));
            try { await window.IrisMilkdown.destroy(); } catch (err) { /* noop */ }
        } finally {
            summary_editor_switching = false;
            $('#sum_toggle_gui').prop('disabled', false);
        }
    } else {
        summary_editor_switching = true;
        $('#sum_toggle_gui').prop('disabled', true);
        try {
            restore_summary_ace_view();   // always syncs ACE from Milkdown
            // Always flush; sync_editor() CRC-dedupes, so this persists edits without churn.
            sync_editor(false);
        } finally {
            summary_editor_switching = false;
            $('#sum_toggle_gui').prop('disabled', false);
        }
    }
}

/* sync_editor
* Save the editor state.
* Check if there are external changes first.
* Copy local changes if conflict
*/
function sync_editor(no_check) {

    $('#last_saved').text('Syncing..').addClass('badge-danger').removeClass('badge-success');

    get_request_api('/case/summary/fetch')
    .done((data) => {
        if (data.status == 'success') {
            if (no_check) {
                // Set the content from remote server
                let applied = apply_remote_summary(data.data.case_description);
                if (applied) {
                    // Set the CRC in page
                    $('#fetched_crc').val(data.data.crc32.toString());
                    $('#last_saved').text('Changes saved').removeClass('badge-danger').addClass('badge-success');
                    $('#content_last_sync').text("Last synced: " + new Date().toLocaleTimeString());
                }
                // If NOT applied we kept unsaved GUI edits: leave fetched_crc at the old
                // baseline so the user's next save is treated as a conflict, not a silent
                // overwrite of the collaborator's change.
            }
            else {
                // Check if content is different
                st = get_active_summary_markdown();
                if (data.data.crc32 != $('#fetched_crc').val()) {
                    // Content has changed remotely
                    // Check if we have changes locally
                    local_crc = crc32(st).toString();
                    console.log('Content changed. Local CRC is ' + local_crc);
                    console.log('Saved CRC is ' + $('#fetched_crc').val());
                    console.log('Remote CRC is ' + data.data.crc32);
                    if (local_crc == $('#fetched_crc').val()) {
                        // No local change, we can sync and update local CRC
                        apply_remote_summary(data.data.case_description);
                        $('#fetched_crc').val(data.data.crc32);
                        $('#last_saved').text('Changes saved').removeClass('badge-danger').addClass('badge-success');
                        $('#content_last_sync').text("Last synced: " + new Date().toLocaleTimeString());
                    } else {
                        // We have a conflict
                        $('#last_saved').text('Conflict !').addClass('badge-danger').removeClass('badge-success');
                        let local_content = st;   // capture before the async prompt applies remote
                        swal ( "Oh no !" ,
                        "We have a conflict with the remote content.\nSomeone may just have changed the description at the same time.\nThe local content will be copied into clipboard and content will be updated with remote." ,
                        "error"
                        ).then((value) => {
                            // Preserve the user's local content before overwriting with remote.
                            try {
                                if (summary_gui_mode && navigator.clipboard) {
                                    // ACE is not the source of truth in GUI mode; copy the
                                    // Milkdown markdown we captured (local_content) instead.
                                    navigator.clipboard.writeText(local_content);
                                } else {
                                    editor.selectAll();
                                    editor.focus();
                                    document.execCommand('copy');
                                }
                            } catch (e) { /* clipboard may be unavailable; remote still applied */ }
                            // force=true: the user accepted remote, so apply over local GUI edits.
                            apply_remote_summary(data.data.case_description, true);
                            $('#fetched_crc').val(data.data.crc32);
                            notify_success('Content updated with remote. Local changes copied to clipboard.');
                            $('#content_last_sync').text("Last synced: " + new Date().toLocaleTimeString());
                        });
                    }
                } else {
                    // Content did not change remotely
                    // Check local change
                    local_crc = crc32(st).toString();
                    if (local_crc != $('#fetched_crc').val()) {
                        console.log('Local change. Old CRC is ' + local_crc);
                        console.log('New CRC is ' + $('#fetched_crc').val());
                        var data = Object();
                        data['case_description'] = st;
                        data['csrf_token'] = $('#csrf_token').val();
                        // Local change detected. Update to remote
                        $.ajax({
                            url: '/case/summary/update' + case_param(),
                            type: "POST",
                            dataType: "json",
                            contentType: "application/json;charset=UTF-8",
                            data: JSON.stringify(data),
                            success: function (data) {
                                if (data.status == 'success') {
                                    collaborator.save();
                                    summary_gui_dirty = false;   // saved: GUI edits are now persisted
                                    $('#content_last_sync').text("Last synced: " + new Date().toLocaleTimeString());
                                    $('#fetched_crc').val(data.data);
                                    $('#last_saved').text('Changes saved').removeClass('badge-danger').addClass('badge-success');
                                } else {
                                    notify_error("Unable to save content to remote server");
                                    $('#last_saved').text('Error saving !').addClass('badge-danger').removeClass('badge-success');
                                }
                            },
                            error: function(error) {
                                notify_error(error.responseJSON.message);
                                ('#last_saved').text('Error saving !').addClass('badge-danger').removeClass('badge-success');
                            }
                        });
                    }
                    $('#content_last_sync').text("Last synced: " + new Date().toLocaleTimeString());
                    $('#last_saved').text('Changes saved').removeClass('badge-danger').addClass('badge-success');
                }
            }
        }
    });
}


is_typing = "";
function auto_remove_typing() {
    if ($("#content_typing").text() == is_typing) {
        $("#content_typing").text("");
    } else {
        is_typing = $("#content_typing").text();
    }
}

function case_pipeline_popup() {
    url = '/case/pipelines-modal' + case_param();
    $('#info_case_modal_content').load(url, function (response, status, xhr) {
        if (status !== "success") {
             ajax_notify_error(xhr, url);
             return false;
        }
        $('#modal_case_detail').modal({ show: true });
        $("#update_pipeline_selector").selectpicker({
            liveSearch: true,
            style: "btn-outline-white"
            })
        $('#update_pipeline_selector').selectpicker("refresh");
        $(".control-update-pipeline-args ").hide();
        $('.control-update-pipeline-'+ $('#update_pipeline_selector').val() ).show();
        $('#update_pipeline_selector').on('change', function(e){
          $(".control-update-pipeline-args ").hide();
          $('.control-update-pipeline-'+this.value).show();
        });
        $('[data-toggle="popover"]').popover();
    });
}

async function do_case_review(action, reviewer_id) {
    let data = Object();
    data['csrf_token'] = $('#csrf_token').val();
    data['action'] = action;
    if (reviewer_id) {
        data['reviewer_id'] = reviewer_id;
    }

    return post_request_api('/case/review/update', JSON.stringify(data));
}

function case_detail(case_id, edit_mode=false) {
    url = '/case/details/' + case_id + case_param();
    $('#info_case_modal_content').load(url, function (response, status, xhr) {
        if (status !== "success") {
             ajax_notify_error(xhr, url);
             return false;
        }
        $('#modal_case_detail').modal({ show: true });
        if (edit_mode) {
            edit_case_info();
        }

        $('#modal_case_detail').off('hide.bs.modal').on("hide.bs.modal", function (e) {
            location.reload();
        });
    });
}

function manage_case(case_id) {
   window.location = '/manage/cases?cid='+ case_id +'#view';
}


$(document).ready(function() {

    if ($("#editor_summary").attr("data-theme") !== "dark") {
        editor.setTheme("ace/theme/tomorrow");
    } else {
        editor.setTheme("ace/theme/iris_night");
    }
    editor.session.setMode("ace/mode/markdown");
    editor.renderer.setShowGutter(true);
    editor.setOption("showLineNumbers", true);
    editor.setOption("showPrintMargin", false);
    editor.setOption("displayIndentGuides", true);
    editor.setOption("indentedSoftWrap", false);
    editor.session.setUseWrapMode(true);
    editor.setOption("maxLines", "Infinity")
    editor.renderer.setScrollMargin(8, 5)
    editor.setOption("enableBasicAutocompletion", true);
    editor.commands.addCommand({
        name: 'save',
        bindKey: {win: "Ctrl-S", "mac": "Cmd-S"},
        exec: function(editor) {
            sync_editor(false);
        }
    })
    editor.commands.addCommand({
        name: 'bold',
        bindKey: {win: "Ctrl-B", "mac": "Cmd-B"},
        exec: function(editor) {
            editor.insertSnippet('**${1:$SELECTION}**');
        }
    });
    editor.commands.addCommand({
        name: 'italic',
        bindKey: {win: "Ctrl-I", "mac": "Cmd-I"},
        exec: function(editor) {
            editor.insertSnippet('*${1:$SELECTION}*');
        }
    });
    editor.commands.addCommand({
        name: 'head_1',
        bindKey: {win: "Ctrl-Shift-1", "mac": "Cmd-Shift-1"},
        exec: function(editor) {
            editor.insertSnippet('# ${1:$SELECTION}');
        }
    });
    editor.commands.addCommand({
        name: 'head_2',
        bindKey: {win: "Ctrl-Shift-2", "mac": "Cmd-Shift-2"},
        exec: function(editor) {
            editor.insertSnippet('## ${1:$SELECTION}');
        }
    });
    editor.commands.addCommand({
        name: 'head_3',
        bindKey: {win: "Ctrl-Shift-3", "mac": "Cmd-Shift-3"},
        exec: function(editor) {
            editor.insertSnippet('### ${1:$SELECTION}');
        }
    });
    editor.commands.addCommand({
        name: 'head_4',
        bindKey: {win: "Ctrl-Shift-4", "mac": "Cmd-Shift-4"},
        exec: function(editor) {
            editor.insertSnippet('#### ${1:$SELECTION}');
        }
    });
    $('#editor_summary').on('paste', (event) => {
        event.preventDefault();
        handle_ed_paste(event);
    });

    var timer;
    var timeout = 10000;
    $('#editor_summary').keyup(function(){
        if(timer) {
             clearTimeout(timer);
        }
        timer = setTimeout(sync_editor, timeout);
    });


    //var textarea = $('#case_summary');
    editor.getSession().on("change", function () {
        //textarea.val(do_md_filter_xss(editor.getSession().getValue()));
        $('#last_saved').text('Changes not saved').addClass('badge-danger').removeClass('badge-success');
        let target = document.getElementById('targetDiv');
        let converter = get_showdown_convert();
        let html = converter.makeHtml(do_md_filter_xss(editor.getSession().getValue()));

        target.innerHTML = do_md_filter_xss(html);

    });

    edit_case_summary();
    body_loaded();
    sync_editor(true);
    setInterval(auto_remove_typing, 2000);

    let review_state = $('#caseReviewState');
    if (review_state.length > 0) {
        let current_review_state = review_state.data('review-state');

        if (current_review_state === 'Review in progress') {
            $(".btn-start-review").hide();
            $(".btn-confirm-review").show();
            $(".btn-cancel-review").show();
            $('#reviewSubtitle').text('You started this review. Press "Confirm review" when you are done.');
        } else if (current_review_state === 'Review completed') {
            $(".btn-start-review").hide();
            $(".btn-confirm-review").hide();
            $(".btn-cancel-review").hide();
        } else if (current_review_state === 'Pending review') {
            $(".btn-start-review").show();
            $(".btn-confirm-review").hide();
            $(".btn-cancel-review").hide();
        }
        $('.review-card').show();
    }

    $('.btn-start-review').on('click', function(e){
        do_case_review('start').then(function(data) {
            if (notify_auto_api(data)) {
                location.reload();
            }
        });
    });

     $('.btn-confirm-review').on('click', function(e){
        do_case_review('done').then(function(data) {
            if (notify_auto_api(data)) {
                location.reload();
            }
        });
     });

     $('.btn-cancel-review').on('click', function(e){
        do_case_review('cancel').then(function(data) {
            if (notify_auto_api(data)) {
                location.reload();
            }
        });
     });

     $('#request_review').on('click', function(e){
        let reviewer_id = $('#caseReviewState').data('reviewer-id');
        let reviewer_name = $('#caseReviewState').data('reviewer-name');



        if (reviewer_id !== "None") {
            swal({
                title: "Request review",
                text: "Request a case review from " + reviewer_name + "?",
                icon: "info",
                buttons: true,
                dangerMode: false,
            }).then((willRequest) => {
                if (willRequest) {
                    do_case_review('request', reviewer_id).then(function (data) {
                        if (notify_auto_api(data)) {
                            location.reload();
                        }
                    });
                }
            });
        } else {
            $('#reviewer_id').selectpicker({
                liveSearch: true,
                size: 10,
                width: '100%'
            });
            get_request_api('/case/users/list')
            .done((data) => {
                if (notify_auto_api(data)) {
                    let users = data.data;
                    let options = '';
                    for (let i = 0; i < users.length; i++) {
                        if (users[i].user_access_level === 4) {
                            options += '<option value="' + users[i].user_id + '">' + filterXSS(users[i].user_name) + '</option>';
                        }
                    }
                    $('#reviewer_id').html(options);
                    $('#reviewer_id').selectpicker('refresh');
                    $('#modal_choose_reviewer').modal('show');

                    $('#submit_set_reviewer').off('click').on('click', function(e){
                        let reviewer_id = $('#reviewer_id').val();
                        do_case_review('request', reviewer_id).then(function (data) {
                            if (notify_auto_api(data)) {
                                location.reload();
                            }
                        });
                    });
                }
            });

        }

     });

});


