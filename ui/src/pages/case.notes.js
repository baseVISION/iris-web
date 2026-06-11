/* Defines the kanban board */
let note_split;
let session_id = null ;
let collaborator = null ;
let collaborator_socket = null ;
let is_typing = "";
let ppl_viewing = new Map();
let timer_socket = 0;
let note_id = null;
let last_ping = 0;
let cid = null;
let previousNoteTitle = null;
let timer = null;
let timeout = 5000;
let note_dirty = false;
let note_collab_persist_timer = null;
let note_collab_idle_snapshot_timer = null;
let note_collab_last_persist_hash = null;
let note_collab_last_snapshot_hash = null;
let note_collab_changed_since_snapshot = false;

const NOTE_COLLAB_PERSIST_DEBOUNCE_MS = 4000;
const NOTE_COLLAB_IDLE_SNAPSHOT_MS = 60000;

const NOTE_COLLAB_COLORS = [
    '#0f766e',
    '#2563eb',
    '#7c3aed',
    '#c2410c',
    '#be123c',
    '#047857',
    '#4338ca',
    '#b45309',
    '#0369a1',
    '#a21caf',
];

function hash_note_collab_string(value) {
    let hash = 0;
    const str = value || 'IRIS';
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function hash_note_content(value) {
    const text = value || '';
    return `${text.length}:${hash_note_collab_string(text)}`;
}

function get_note_collab_user() {
    let whoami = null;
    if (typeof userWhoami !== 'undefined' && userWhoami) {
        whoami = userWhoami;
    } else {
        try {
            whoami = JSON.parse(sessionStorage.getItem('userWhoami'));
        } catch (e) {
            whoami = null;
        }
    }

    const name = (whoami && (whoami.user_name || whoami.user_login))
        || $('#current_username').text()
        || 'IRIS user';
    return {
        name,
        color: NOTE_COLLAB_COLORS[hash_note_collab_string(name) % NOTE_COLLAB_COLORS.length],
    };
}

function is_note_collab_active() {
    return !!(note_split && typeof note_split.isCollabActive === 'function' && note_split.isCollabActive());
}

function is_note_collab_last_client() {
    return !note_split
        || typeof note_split.isLastCollabClient !== 'function'
        || note_split.isLastCollabClient();
}

function clear_note_collab_timers() {
    if (note_collab_persist_timer) {
        clearTimeout(note_collab_persist_timer);
        note_collab_persist_timer = null;
    }
    if (note_collab_idle_snapshot_timer) {
        clearTimeout(note_collab_idle_snapshot_timer);
        note_collab_idle_snapshot_timer = null;
    }
}

function reset_note_collab_state(markdown) {
    clear_note_collab_timers();
    const hash = hash_note_content(markdown || '');
    note_collab_last_persist_hash = hash;
    note_collab_last_snapshot_hash = hash;
    note_collab_changed_since_snapshot = false;
}

function note_collab_payload(markdown) {
    return {
        csrf_token: $('#csrf_token').val(),
        note_content: markdown || '',
        client_hash: hash_note_content(markdown || ''),
    };
}

function note_collab_mark_persisted(hash) {
    note_collab_last_persist_hash = hash;
    note_dirty = false;
    $("#content_last_saved_by").text('Last persisted by you');
    $('#btn_save_note').text("Snapshot").removeClass('btn-success btn-danger btn-warning').addClass('btn-light');
}

function note_collab_persist(noteId, markdown, options = {}) {
    if (!noteId) {
        return Promise.resolve({ skipped: true });
    }

    const md = markdown !== undefined ? markdown : get_active_note_markdown();
    const hash = hash_note_content(md);
    if (!options.force && hash === note_collab_last_persist_hash) {
        return Promise.resolve({ skipped: true, hash });
    }

    return new Promise((resolve, reject) => {
        post_request_api(
            `/case/notes/${noteId}/collab/persist`,
            JSON.stringify(note_collab_payload(md)),
            false,
            undefined,
            cid
        )
        .done((data) => {
            if (api_request_failed(data)) {
                reject(data);
                return;
            }
            note_collab_mark_persisted(hash);
            resolve({ skipped: false, hash, data });
        })
        .fail(reject);
    });
}

function note_collab_snapshot(noteId, markdown, options = {}) {
    if (!noteId) {
        return Promise.resolve({ skipped: true });
    }

    const md = markdown !== undefined ? markdown : get_active_note_markdown();
    const hash = hash_note_content(md);
    if (!options.force && !note_collab_changed_since_snapshot && hash === note_collab_last_snapshot_hash) {
        return Promise.resolve({ skipped: true, hash });
    }

    return new Promise((resolve, reject) => {
        post_request_api(
            `/case/notes/${noteId}/collab/snapshot`,
            JSON.stringify({
                csrf_token: $('#csrf_token').val(),
                client_hash: hash,
            }),
            false,
            undefined,
            cid
        )
        .done((data) => {
            if (api_request_failed(data)) {
                reject(data);
                return;
            }
            note_collab_last_snapshot_hash = hash;
            note_collab_changed_since_snapshot = false;
            $('#btn_save_note').text(data.data && data.data.revision_created ? "Snapshotted" : "Snapshot")
                .addClass('btn-success')
                .removeClass('btn-danger btn-warning');
            resolve({
                skipped: false,
                hash,
                revision_created: !!(data.data && data.data.revision_created),
                data,
            });
        })
        .fail(reject);
    });
}

async function note_collab_persist_and_snapshot(noteId, markdown, options = {}) {
    const md = markdown !== undefined ? markdown : get_active_note_markdown();
    await note_collab_persist(noteId, md, { force: options.forcePersist });
    return note_collab_snapshot(noteId, md, { force: options.forceSnapshot });
}

function schedule_note_collab_persist() {
    const n_id = $('#currentNoteIDLabel').data('note_id');
    if (!n_id) {
        return;
    }
    if (note_collab_persist_timer) {
        clearTimeout(note_collab_persist_timer);
    }
    note_collab_persist_timer = setTimeout(() => {
        note_collab_persist_timer = null;
        note_collab_persist(n_id).catch(() => {});
    }, NOTE_COLLAB_PERSIST_DEBOUNCE_MS);
}

function schedule_note_collab_idle_snapshot() {
    const n_id = $('#currentNoteIDLabel').data('note_id');
    if (!n_id) {
        return;
    }
    if (note_collab_idle_snapshot_timer) {
        clearTimeout(note_collab_idle_snapshot_timer);
    }
    note_collab_idle_snapshot_timer = setTimeout(() => {
        note_collab_idle_snapshot_timer = null;
        if (!note_collab_changed_since_snapshot) {
            return;
        }
        note_collab_persist_and_snapshot(n_id).catch(() => {});
    }, NOTE_COLLAB_IDLE_SNAPSHOT_MS);
}

function mark_note_collab_dirty() {
    const md = get_active_note_markdown();
    const hash = hash_note_content(md);
    note_dirty = true;
    note_collab_changed_since_snapshot = true;
    $('#btn_save_note').text(hash === note_collab_last_snapshot_hash ? "Snapshot" : "Snapshot")
        .removeClass('btn-success btn-danger')
        .addClass('btn-warning');
    schedule_note_collab_persist();
    schedule_note_collab_idle_snapshot();
}

function note_collab_sync_post(uri, payload) {
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${uri}?cid=${encodeURIComponent(get_caseid())}`, false);
        xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
        xhr.send(JSON.stringify(payload));
        return xhr.status >= 200 && xhr.status < 300;
    } catch (e) {
        return false;
    }
}

function flush_note_collab_leave_sync(noteId) {
    if (!noteId || !is_note_collab_active() || !is_note_collab_last_client()) {
        return;
    }

    const md = get_active_note_markdown();
    const hash = hash_note_content(md);
    const csrf = $('#csrf_token').val();
    note_collab_sync_post(`/case/notes/${noteId}/collab/persist`, {
        csrf_token: csrf,
        note_content: md,
        client_hash: hash,
    });
    note_collab_sync_post(`/case/notes/${noteId}/collab/snapshot`, {
        csrf_token: csrf,
        client_hash: hash,
    });
}

async function flush_note_collab_before_leave(noteId) {
    if (!noteId || !is_note_collab_active() || !is_note_collab_last_client()) {
        clear_note_collab_timers();
        return;
    }

    const md = get_active_note_markdown();
    clear_note_collab_timers();
    await note_collab_persist_and_snapshot(noteId, md, {
        forcePersist: true,
        forceSnapshot: note_collab_changed_since_snapshot || hash_note_content(md) !== note_collab_last_snapshot_hash,
    }).catch(() => {});
}


const preventFormDefaultBehaviourOnSubmit = (event) => {
    event.preventDefault();
    return false;
};


function Collaborator( session_id, n_id ) {
    this.collaboration_socket = collaborator_socket;

    this.channel = "case-" + session_id + "-notes";

    this.collaboration_socket.off("save-note");
    this.collaboration_socket.off("leave-note");
    this.collaboration_socket.off("join-notes");
    this.collaboration_socket.off("pong-note");
    this.collaboration_socket.off("disconnect");

    this.collaboration_socket.on("save-note", function (data) {
        if (parseInt(data.note_id) !== parseInt(note_id)) return;
        if (is_note_collab_active()) return;
        sync_note(note_id)
            .then(function () {
                $("#content_last_saved_by").text("Last saved by " + data.last_saved);
                $('#btn_save_note').text("Saved").addClass('btn-success').removeClass('btn-danger').removeClass('btn-warning');
            });

    }.bind());

    this.collaboration_socket.on('leave-note', function (data) {
        if (is_note_collab_active()) return;
        if (parseInt(data.note_id) !== parseInt(note_id)) return;
        ppl_viewing.delete(data.user);
        refresh_ppl_list(session_id, note_id);
    });

    this.collaboration_socket.on('join-notes', function (data) {
        if (is_note_collab_active()) return;
        if (parseInt(data.note_id) !== parseInt(note_id)) return;
        if (ppl_viewing.has(data.user)) return;
        ppl_viewing.set(filterXSS(data.user), 1);
        refresh_ppl_list(session_id, note_id);
        collaborator.collaboration_socket.emit('ping-note', {'channel': collaborator.channel, 'note_id': note_id});
    });

    this.collaboration_socket.on('ping-note', function (data) {
        if (is_note_collab_active()) return;
        if (parseInt(data.note_id) !== parseInt(note_id)) return;
        collaborator.collaboration_socket.emit('pong-note', {'channel': collaborator.channel, 'note_id': note_id});
    });

    this.collaboration_socket.on('disconnect', function (data) {
        if (is_note_collab_active()) return;
        ppl_viewing.delete(data.user);
        refresh_ppl_list(session_id, note_id);
    });

    this.collaboration_socket.emit('join-notes', {'channel': this.channel, 'note_id': n_id});

}

Collaborator.prototype.save = function( note_id ) {
    this.collaboration_socket.emit( "save-note", { 'channel': this.channel, 'note_id': note_id } ) ;
}

Collaborator.prototype.close = function( note_id ) {
    this.collaboration_socket.emit( "leave-note", { 'channel': this.channel, 'note_id': note_id } ) ;
}

function auto_remove_typing() {
    if (is_note_collab_active()) {
        $("#content_typing").text("");
        return;
    }
    if ($("#content_typing").text() == is_typing) {
        $("#content_typing").text("");
    } else {
        is_typing = $("#content_typing").text();
    }
}

/* Generates a global sequence id for subnotes */
let current_id = 0;

/* Generates a global sequence id for groups */
var current_gid = 0;

async function get_remote_note(note_id) {
    return get_request_api(`/case/notes/${note_id}`);
}

async function sync_note(node_id) {
    if (is_note_collab_active()) {
        return;
    }

    // Get the remote note
    let remote_note = await get_remote_note(node_id);
    if (remote_note.status !== 'success') {
        return;
    }

    // Get the local note
    let local_note = get_active_note_markdown();

    // If the local note is empty, set it to the remote note
    if (local_note === '') {
        if (note_split) {
            note_split.setMarkdown(remote_note.data.note_content);
            note_dirty = false;
        }
        return;
    }

    // If the local note is not empty, check if it is different from the remote note
    if (local_note !== remote_note.data.note_content) {
        swal({
            title: 'Note conflict',
            text: 'The note has been saved by someone else. Do you want to overwrite your changes?',
            icon: 'warning',
            buttons: {
                cancel: {
                    text: 'Cancel',
                    value: null,
                    visible: true,
                },
                confirm: {
                    text: 'Overwrite',
                    value: true,
                }
            },
            dangerMode: true,
            closeOnEsc: false,
            allowOutsideClick: false,
            allowEnterKey: false
        })
            .then((overwrite) => {
                if (overwrite) {
                    // Overwrite the local note with the remote note
                    if (note_split) {
                        note_split.setMarkdown(remote_note.data.note_content);
                        note_dirty = false;
                    }
                }
            });
    } else {
        note_dirty = false;
    }

    return;
}


function delete_note(_item, cid) {
    if (_item === undefined || _item === null) {
        _item = $('#currentNoteIDLabel').data('note_id')
    }

    do_deletion_prompt("You are about to delete note #" + _item)
    .then((doDelete) => {
        if (doDelete) {
            post_request_api('/case/notes/delete/' + _item, null, null, cid)
            .done((data) => {
               if (notify_auto_api(data)) {
                   load_directories()
                       .then((data) =>
                       {
                           let shared_id = getSharedLink();
                            if (shared_id) {
                                note_detail(shared_id).then((data) => {
                                    if (!data) {
                                        setSharedLink(null);
                                        toggleNoteEditor(false);
                                    }
                                });
                            }
                       }
                   )
               }
            })
        }
    });
}

function proxy_comment_element() {
    let note_id = $('#currentNoteIDLabel').data('note_id');

    return comment_element(note_id, 'notes');
}

function proxy_copy_object_link() {
    let note_id = $('#currentNoteIDLabel').data('note_id');

    return copy_object_link(note_id);
}

function proxy_copy_object_link_md() {
    let note_id = $('#currentNoteIDLabel').data('note_id');

    return copy_object_link_md('note', note_id);
}

function toggleNoteEditor(show_editor) {
    if (show_editor) {
        $('#currentNoteContent').show();
        $('#emptyNoteDisplay').hide();
    } else {
        $('#currentNoteContent').hide();
        $('#emptyNoteDisplay').show();
    }
}

/* Edit one note */
function edit_note(event) {

    var nval = $(event).find('iris_note').attr('id');
    collaborator = null;
    note_detail(nval);

}


function setSharedLink(id) {
    // Set the shared ID in the URL
    let url = new URL(window.location.href);
    if (id !== undefined && id !== null) {
        url.searchParams.set('shared', id);
    } else {
        url.searchParams.delete('shared');
    }
    window.history.replaceState({}, '', url);
}

async function load_note_revisions(_item) {

    if (_item === undefined || _item === null) {
        _item = $('#currentNoteIDLabel').data('note_id')
    }

    get_request_api(`/case/notes/${_item}/revisions/list`)
    .done((data) => {
        if (api_request_failed(data)) {
            return false;
        }
        let revisions = data.data;
        let revisionList = $('#revisionList');
        revisionList.empty();

        revisions.forEach(function(revision) {
            let listItem = $('<li></li>').addClass('list-group-item');
            let link = $('<a class="btn btn-sm btn-outline-dark float-right ml-1" href="#"><i class="fa-solid fa-clock-rotate-left" style="cursor: pointer;" title="Revert"></i> Revert</a>');
            let link_preview = $('<a class="btn btn-sm btn-outline-dark float-right ml-1" href="#"><i class="fa-solid fa-eye" style="cursor: pointer;" title="Preview"></i> Preview</a>');
            let link_delete = $('<a class="btn btn-sm btn-outline-danger float-right ml-1" href="#"><i class="fa-solid fa-trash" style="cursor: pointer;" title="Delete"></i></a>');
            let user = $('<span></span>').text(`#${revision.revision_number} by ${revision.user_name} on ${formatTime(revision.revision_timestamp)}`);
            listItem.append(user);
            listItem.append(link_delete);
            listItem.append(link);
            listItem.append(link_preview);

            revisionList.append(listItem);

            link.on('click', function(e) {
                e.preventDefault();
                note_revision_revert(_item, revision.revision_number);
            });

            link_delete.on('click', function(e) {
                e.preventDefault();
                note_revision_delete(_item, revision.revision_number);
            });

            link_preview.on('click', function(e) {
                e.preventDefault();
                get_request_api(`/case/notes/${_item}/revisions/${revision.revision_number}`)
                .done((data) => {
                    if (api_request_failed(data)) {
                        return;
                    }
                    let revision = data.data;
                    $('#previewRevisionID').text(revision.revision_number);
                    $('#notePreviewModalTitle').text(`#${revision.revision_number} - ${revision.note_title}`);
                    let converter = get_showdown_convert();
                    $('#notePreviewModalContent').html(
                        converter.makeHtml(do_md_filter_xss(revision.note_content || ''))
                    );
                    $('#notePreviewModal').modal('show');
                });
            });

            $('#noteModificationHistoryModal').modal('show');

        });
    });
}

function note_revision_revert(_item, _rev) {
    if (_item === undefined || _item === null) {
        _item = $('#currentNoteIDLabel').data('note_id')
    }
    let close_modal = false;
    if (_rev === undefined || _rev === null) {
        _rev = $('#previewRevisionID').text();
        close_modal = true;
    }

    get_request_api(`/case/notes/${_item}/revisions/${_rev}`)
    .done((data) => {
        if (api_request_failed(data)) {
            return;
        }
        let revision = data.data;
        $('#currentNoteTitle').text(revision.note_title);
        if (note_split) {
            note_split.setMarkdown(revision.note_content);
        }
        if (close_modal) {
            $('#notePreviewModal').modal('hide');
        }
        $('#noteModificationHistoryModal').modal('hide');
        if (is_note_collab_active()) {
            clear_note_collab_timers();
            note_collab_changed_since_snapshot = true;
            note_collab_persist_and_snapshot(_item, revision.note_content || '', {
                forcePersist: true,
                forceSnapshot: true,
            })
            .then((result) => {
                notify_success(result.revision_created
                    ? 'Reverted to revision #' + _rev + ' and snapshotted.'
                    : 'Reverted to revision #' + _rev + '. Latest snapshot already matched.');
            })
            .catch(() => {
                notify_error('Note reverted locally, but collab snapshot failed.');
            });
            return;
        }
        mark_note_dirty();
        notify_success('Note reverted to revision #' + _rev + '. Save to apply changes.');
    });
}

function note_revision_delete(_item, _rev) {
    if (_item === undefined || _item === null) {
        _item = $('#currentNoteIDLabel').data('note_id')
    }

    let close_modal = false;
    if (_rev === undefined || _rev === null) {
        _rev = $('#previewRevisionID').text();
        close_modal = true;
    }

    do_deletion_prompt("You are about to delete revision #" + _rev)
    .then((doDelete) => {
        if (doDelete) {
            post_request_api('/case/notes/' + _item + '/revisions/' + _rev + '/delete')
            .done((data) => {
                if (notify_auto_api(data)) {
                    load_note_revisions(_item);
                }

                if (close_modal) {
                    $('#notePreviewModal').modal('hide');
                }

            });
        }
    });
}

/* Fetch the edit modal with content from server */
function wait_for_split_editor() {
    if (window.IrisSplitEditor) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        window.addEventListener('iris-split-editor-ready', resolve, { once: true });
    });
}

async function note_detail(id) {

    get_request_api(`/case/notes/${id}`)
    .done(async (data) => {
        if (data.status === 'success') {
            let previous_note_id = $('#currentNoteIDLabel').data('note_id');

            if (timer) {
                clearTimeout(timer);
                timer = null;
            }

            if (note_split) {
                let previous_note_markdown = previous_note_id ? note_split.getMarkdown() : null;
                if (is_note_collab_active()) {
                    await flush_note_collab_before_leave(previous_note_id);
                } else if (note_dirty && previous_note_id) {
                    silent_save_note(previous_note_id, previous_note_markdown);
                }
                await note_split.destroy();
                note_split = null;
                note_dirty = false;
            }

            if (collaborator !== null) {
                collaborator.close(previous_note_id);
            }

            note_id = id;
            collaborator = null;

            await wait_for_split_editor();

            $('#currentNoteTitle').text(data.data.note_title);
            previousNoteTitle = data.data.note_title;
            $('#currentNoteIDLabel').text(`#${data.data.note_id} - ${data.data.note_uuid}`)
                .data('note_id', data.data.note_id);

            let target_note = id;
            reset_note_collab_state(data.data.note_content || '');
            note_split = await window.IrisSplitEditor.create({
                container: '#note_split',
                sourcePane: '#note_source',
                previewPane: '#milkdown_root',
                divider: '#note_divider',
                viewToggle: document.querySelector('.iris-view-toggle'),
                initialMarkdown: data.data.note_content,
                onChange: mark_note_dirty,
                collab: {
                    room: 'note-' + data.data.note_id,
                    user: get_note_collab_user(),
                    presenceTarget: '#ppl_list_viewing',
                    onStatus: function(status) {
                        $('#note_split').attr('data-collab-status', status || '');
                    },
                },
            });

            if (note_id !== target_note) {
                await note_split.destroy();
                note_split = null;
                return false;
            }

            note_split.focus();
            if (!is_note_collab_active()) {
                collaborator = new Collaborator(get_caseid(), id);
            }

            load_menu_mod_options_modal(id, 'note', $("#note_quick_actions"));

            if (!is_note_collab_active()) {
                collaborator_socket.emit('ping-note', { 'channel': 'case-' + get_caseid() + '-notes', 'note_id': note_id });
            }

            toggleNoteEditor(true);

            $('.note').removeClass('note-highlight');
            $('#note-' + id).addClass('note-highlight');

            $('#object_comments_number').text(data.data.comments.length > 0 ? data.data.comments.length: '');
            $('#content_last_saved_by').text('');
            $('#content_typing').text('');
            $('#btn_save_note').text("Snapshot").removeClass('btn-success btn-danger btn-warning').addClass('btn-light');
            note_dirty = false;

            setSharedLink(id);

            return true;
        } else {
            setSharedLink();
            return false;
        }

    });
}

function refresh_ppl_list() {
    if (is_note_collab_active()) {
        $('#ppl_list_viewing').empty();
        return;
    }
    $('#ppl_list_viewing').empty();
    for (let [key, value] of ppl_viewing) {
        $('#ppl_list_viewing').append(get_avatar_initials(key, false, undefined, true));
    }
}

/* Delete a group of the dashboard */
function search_notes() {
    var data = Object();
    data['search_term'] = $("#search_note_input").val();
    data['csrf_token'] = $("#csrf_token").val();

    post_request_api('/case/notes/search', JSON.stringify(data))
    .done((data) => {
        if (data.status == 'success') {
            $('#notes_search_list').empty();
            for (e in data.data) {
                let lit_tag = $('<li>');
                lit_tag.addClass('list-group-item list-group-item-action note');
                lit_tag.attr('id', 'note-' + data.data[e]['note_id']);
                lit_tag.attr('onclick', 'note_detail(' + data.data[e]['note_id'] + ');');
                lit_tag.text(data.data[e]['note_title']);
                $('#notes_search_list').append(lit_tag);

            }
            $('#notes_search_list').show();

        } else {
            if (data.message != "No data to load for dashboard") {
                swal("Oh no !", data.message, "error");
            }
        }
    })
}

/* Returns the current note markdown from the split editor. */
function get_active_note_markdown() {
    return note_split ? note_split.getMarkdown() : '';
}

/* Mark the note as having unsaved changes and schedule an autosave. */
function mark_note_dirty(markdown) {
    if (is_note_collab_active()) {
        mark_note_collab_dirty(markdown);
        return;
    }

    note_dirty = true;
    $("#content_typing").text("You are typing..");
    $('#btn_save_note').text("Save").removeClass('btn-success').addClass('btn-warning').removeClass('btn-danger');
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(save_note, timeout);
}

/* Persist a note's markdown without mutating the current UI (used to flush GUI edits when
   navigating away from a note; avoids stale "Saved" indicators landing on the next note). */
function silent_save_note(noteId, md) {
    if (!noteId) { return; }
    let ret = get_custom_attributes_fields();
    if (ret[0].length > 0) { return; }   // attribute validation errors: skip flush
    let data_sent = Object();
    data_sent['note_title'] = $('#currentNoteTitle').text() ? $('#currentNoteTitle').text() : $('#currentNoteTitleInput').val();
    data_sent['csrf_token'] = $('#csrf_token').val();
    data_sent['note_content'] = md !== undefined ? md : get_active_note_markdown();
    data_sent['custom_attributes'] = ret[1];
    post_request_api('/case/notes/update/' + noteId, JSON.stringify(data_sent), false, undefined, cid);
}

/* Save a note into db */
function save_note() {
    clear_api_error();
    let n_id = $('#currentNoteIDLabel').data('note_id')

    if (!n_id) { return false; }

    if (is_note_collab_active()) {
        if (note_collab_persist_timer) {
            clearTimeout(note_collab_persist_timer);
            note_collab_persist_timer = null;
        }
        const md = get_active_note_markdown();
        $('#btn_save_note').text("Snapshotting").removeClass('btn-success btn-danger').addClass('btn-warning');
        note_collab_persist_and_snapshot(n_id, md, { forceSnapshot: true })
            .then((result) => {
                notify_success(result.revision_created
                    ? 'Note snapshot created.'
                    : 'Note already matches latest snapshot.');
            })
            .catch(() => {
                $('#btn_save_note').text("Snapshot error").removeClass('btn-success btn-warning').addClass('btn-danger');
            });
        return false;
    }

    let data_sent = Object();
    let currentNoteTitle = $('#currentNoteTitle').text() ? $('#currentNoteTitle').text() : $('#currentNoteTitleInput').val();
    data_sent['note_title'] = currentNoteTitle;
    data_sent['csrf_token'] = $('#csrf_token').val();
    data_sent['note_content'] = get_active_note_markdown();
    let ret = get_custom_attributes_fields();
    let has_error = ret[0].length > 0;
    let attributes = ret[1];

    if (has_error){return false;}

    data_sent['custom_attributes'] = attributes;

    post_request_api('/case/notes/update/'+ n_id, JSON.stringify(data_sent), false, undefined, cid, function() {
        $('#btn_save_note').text("Error saving!").removeClass('btn-success').addClass('btn-danger').removeClass('btn-danger');
    })
    .done((data) => {
        if (api_request_failed(data)) {
            return;
        }
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        note_dirty = false;
        $('#btn_save_note').text("Saved").addClass('btn-success').removeClass('btn-danger').removeClass('btn-warning');
        $("#content_last_saved_by").text('Last saved by you');

        if (collaborator) {
            collaborator.save(n_id);
        }

        if (previousNoteTitle !== currentNoteTitle) {
            load_directories().then(function() {
                $('.note').removeClass('note-highlight');
                $('#note-' + n_id).addClass('note-highlight');
            });
            previousNoteTitle = currentNoteTitle;
        }
    });
}

async function load_directories() {
    return get_request_api('/case/notes/directories/filter')
        .done((data) => {
            if (api_request_failed(data)) {
                return;
            }
            data = data.data;
            let directoriesListing = $('#directoriesListing');
            directoriesListing.empty();

            let directoryMap = new Map();
            data.forEach(function(directory) {
                directoryMap.set(directory.id, directory);
            });

            let subdirectoryIds = new Set();
            data.forEach(function(directory) {
                directory.subdirectories.forEach(function(subdirectory) {
                    subdirectoryIds.add(subdirectory.id);
                });
            });

            let directories = data.filter(function(directory) {
                return !subdirectoryIds.has(directory.id);
            });

            directories.forEach(function(directory) {
                directoriesListing.append(createDirectoryListItem(directory, directoryMap));
            });
        });
}

function download_note() {
    // Use the content of whichever editor is currently active (ACE or Milkdown)
    let content = get_active_note_markdown();
    let filename = $('#currentNoteTitle').text() + '.md';
    let blob = new Blob([content], {type: 'text/plain'});
    let url = window.URL.createObjectURL(blob);

    // Create a link to the file and click it to download it
    let link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
}

function add_note(directory_id) {
    let data = Object();
    data['directory_id'] = directory_id;
    data['note_title'] = 'New note';
    data['note_content'] = '';
    data['csrf_token'] = $('#csrf_token').val();

    post_request_api('/case/notes/add', JSON.stringify(data))
    .done((data) => {
        if (api_request_failed(data)) {
            return;
        }
        note_detail(data.data.note_id);
        load_directories().then(function() {
            $('.note').removeClass('note-highlight');
            $('#note-' + data.data.note_id).addClass('note-highlight');
        });
    });
}

function add_folder(directory_id) {
    let data = Object();
    data['parent_id'] = directory_id;
    data['name'] = 'New folder';
    data['csrf_token'] = $('#csrf_token').val();

    post_request_api('/case/notes/directories/add', JSON.stringify(data))
    .done((data) => {
        if (api_request_failed(data)) {
            return;
        }
        rename_folder(data.data.id);
    });
}

function refresh_folders() {
    load_directories().then(function() {
        notify_success('Tree  refreshed');
        let note_id = $('#currentNoteIDLabel').data('note_id');
        $('.note').removeClass('note-highlight');
        $('#note-' + note_id).addClass('note-highlight');
    });
}

function toggleDirectories() {
    // Select all directory elements
    let directories = $('.directory-container');

    // Toggle the visibility of the directories
    directories.toggle();

}

function rename_folder_api(directory_id, newName) {
    let data = Object();
    data['name'] = newName;
    data['csrf_token'] = $('#csrf_token').val();

    post_request_api(`/case/notes/directories/update/${directory_id}`,
        JSON.stringify(data))
    .done((data) => {
        if (notify_auto_api(data)) {
            load_directories();
        }
    });
}

function delete_folder_api(directory_id) {
    let data = Object();
    data['csrf_token'] = $('#csrf_token').val();

    post_request_api(`/case/notes/directories/delete/${directory_id}`,
        JSON.stringify(data))
    .done((data) => {
        if (notify_auto_api(data)) {
            load_directories();
        }
    });
}

function move_note_api(note_id, new_directory_id) {
    let data = Object();
    data['csrf_token'] = $('#csrf_token').val();
    data['directory_id'] = new_directory_id;

    return post_request_api(`/case/notes/update/${note_id}`,
        JSON.stringify(data));
}

function move_item(item_id, item_type) {
    // Create a modal with a list of directories to move the folder to
    let modal = $('#moveFolderModal');

    let directoriesListing = $('<ul></ul>');
    $('#dirListingMove').empty().append(directoriesListing);

    let directoryMap = new Map();
    $('#directoriesListing').find('li').filter('.directory').each(function() {
        let directory = $(this).data('directory');
        directoryMap.set(directory.id, directory);
    });

    let subdirectoryIds = new Set();

    function addSubdirectoryIds(directory) {
        directory.subdirectories.forEach(function(subdirectory) {
            subdirectoryIds.add(subdirectory.id);
            let subdirectoryData = directoryMap.get(subdirectory.id);
            if (subdirectoryData) {
                addSubdirectoryIds(subdirectoryData);
            }
        });
    }

    directoryMap.forEach(function(directory) {
        addSubdirectoryIds(directory);
    });

    let directories = Array.from(directoryMap.values()).filter(function(directory) {
        return item_type === 'folder' ? (item_id !== directory.id) : true;
    });

    let listItem = $('<li></li>');
    let link = $('<a></a>').attr('href', '#').text('Root');
    listItem.append(link);

    link.on('click', function(e) {
        e.preventDefault();
        if (item_type === 'note') {
            move_note_api(item_id, null).then(function() {
                modal.modal('hide');
            });
        }
        else if (item_type === 'folder') {
            move_folder_api(item_id, null).then(function () {
                modal.modal('hide');
            });
        }
    });

    directoriesListing.append(listItem);

    directories.forEach(function(directory) {
        let listItem = $('<li></li>');
        let link = $('<a></a>').attr('href', '#');
        link.append($('<i></i>').addClass('fa-regular fa-folder mr-2'));  // Add a folder icon
        link.append(' ' + directory.name);
        listItem.append(link);

        link.on('click', function(e) {
            e.preventDefault();
            if (item_type === 'note') {
                move_note_api(item_id, directory.id).then(function() {
                    // reload the directories
                    load_directories()
                    .then(function() {
                        note_detail(item_id);
                        modal.modal('hide');
                    });
                });
            }
            else if (item_type === 'folder') {
                move_folder_api(item_id, directory.id).then(function () {
                    load_directories()
                    .then(function() {
                        modal.modal('hide');
                    });
                });
            }
        });

        directoriesListing.append(listItem);
    });

    modal.modal('show');
}

async function move_folder_api(directory_id, new_parent_id) {
    let data = Object();
    data['csrf_token'] = $('#csrf_token').val();
    data['parent_id'] = new_parent_id;

    return post_request_api(`/case/notes/directories/update/${directory_id}`,
        JSON.stringify(data))
    .done((data) => {
        if (notify_auto_api(data)) {
            load_directories();
        }
    });
}

function delete_folder(directory_id) {
    swal({
        title: 'Delete folder',
        text: 'Are you sure you want to delete this folder? All subfolders and notes will be deleted as well.',
        icon: 'warning',
        buttons: {
            cancel: {
                text: 'Cancel',
                value: null,
                visible: true,
            },
            confirm: {
                text: 'Delete',
                value: true,
            }
        },
        dangerMode: true,
        closeOnEsc: false,
        allowOutsideClick: false,
        allowEnterKey: false
    })
        .then((willDelete) => {
            if (willDelete) {
                delete_folder_api(directory_id);
            }
        });
}

function rename_folder(directory_id, new_directory=false) {

    // Prompt the user for a new name
    swal({
        title: new_directory?  'Rename directory': "Name the new folder",
        text: 'Enter a new name for the folder',
        content: 'input',
        buttons: {
            cancel: {
                text: 'Cancel',
                value: null,
                visible: true,
            },
            confirm: {
                text: new_directory ? 'Ok' : 'Rename',
                value: true,
            }
        },
        dangerMode: true,
        closeOnEsc: false,
        allowOutsideClick: false,
        allowEnterKey: false
    })
        .then((newName) => {
            if (newName) {
                rename_folder_api(directory_id, newName);
            }
        });
}

function fetchNotes(searchInput) {
    // Send a GET request to the server with the search input as a parameter
    get_raw_request_api(`/case/notes/search?search_input=${encodeURIComponent(searchInput)}&cid=${get_caseid()}`)
        .done(data => {
            if (api_request_failed(data)) {
                return;
            }
            $('.directory-container').find('li').hide();
            $('.directory').hide();
            $('.note').hide();

            data.data.forEach(note => {
                // Show the note
                $('#note-' + note.note_id).show();

                // Show all ancestor directories of the note
                let parentDirectory = $('#directory-' + note.directory_id);
                while (parentDirectory.length > 0) {
                    parentDirectory.show();
                    parentDirectory = parentDirectory.parents('.directory').first();
                }
            });
        });
}

function getNotesInfo(directory, directoryMap, currentNoteID) {
    let totalNotes = directory.notes.length;
    let hasMoreThanFiveNotes = directory.notes.length > 5;
    let dirContainsCurrentNote = directory.notes.some(note => note.id == currentNoteID);

    for (let i = 0; i < directory.subdirectories.length; i++) {
        let subdirectoryId = directory.subdirectories[i].id;
        let subdirectory = directoryMap.get(subdirectoryId);
        if (subdirectory) {
            let subdirectoryInfo = getNotesInfo(subdirectory, directoryMap, currentNoteID);
            totalNotes += subdirectoryInfo.totalNotes;
            hasMoreThanFiveNotes = hasMoreThanFiveNotes || subdirectoryInfo.hasMoreThanFiveNotes;
            dirContainsCurrentNote = dirContainsCurrentNote || subdirectoryInfo.dirContainsCurrentNote;
        }
    }

    return { totalNotes, hasMoreThanFiveNotes, dirContainsCurrentNote };
}



function createDirectoryListItem(directory, directoryMap) {
    // Create a list item for the directory
    var listItem = $('<li></li>').attr('id', 'directory-' + directory.id).addClass('directory');
    listItem.data('directory', directory);
    var link = $('<a></a>').attr('href', '#');
    var icon = $('<i></i>').addClass('fa-regular fa-folder');  // Create an icon for the directory
    link.append(icon);
    link.append($('<span>').text(directory.name));
    listItem.append(link);

    let currentNoteID = getSharedLink();

    var container = $('<div></div>').addClass('directory-container');
    listItem.append(container);

    let notesInfo = getNotesInfo(directory, directoryMap, currentNoteID);
    icon.append($('<span></span>').addClass('notes-number').text(notesInfo.totalNotes));
    if (!notesInfo.hasMoreThanFiveNotes || notesInfo.dirContainsCurrentNote) {
        icon.removeClass('fa-folder').addClass('fa-folder-open');
    } else {
        container.hide();
    }

    link.on('click', function(e) {
        e.preventDefault();
        container.slideToggle();
        icon.toggleClass('fa-folder fa-folder-open');
    });

    link.on('contextmenu', function(e) {
        e.preventDefault();

        let menu = $('<div></div>').addClass('dropdown-menu show').css({
            position: 'absolute',
            left: e.pageX,
            top: e.pageY
        });

        menu.append($('<a></a>').addClass('dropdown-item').attr('href', '#').text('Add note').on('click', function(e) {
            e.preventDefault();
            add_note(directory.id);
        }));
        menu.append($('<a></a>').addClass('dropdown-item').attr('href', '#').text('Add directory').on('click', function(e) {
            e.preventDefault();
            add_folder(directory.id);
        }));

        menu.append($('<div></div>').addClass('dropdown-divider'));
        menu.append($('<a></a>').addClass('dropdown-item').attr('href', '#').text('Rename').on('click', function(e) {
            e.preventDefault();
            rename_folder(directory.id);
        }));
        menu.append($('<a></a>').addClass('dropdown-item').attr('href', '#').text('Move').on('click', function(e) {
            e.preventDefault();
            move_item(directory.id, 'folder');
        }));

        menu.append($('<div></div>').addClass('dropdown-divider'));
        menu.append($('<a></a>').addClass('dropdown-item text-danger').attr('href', '#').text('Delete').on('click', function(e) {
            e.preventDefault();
            delete_folder(directory.id);
        }));

        $('body').append(menu).on('click', function() {
            menu.remove();
        });
    });

    // If the directory has subdirectories, create a list item for each subdirectory
    if (directory.subdirectories && directory.subdirectories.length > 0) {
        var subdirectoriesList = $('<ul></ul>').addClass('nav');
        directory.subdirectories.forEach(function(subdirectory) {
            // Look up the subdirectory in the directoryMap
            var subdirectoryData = directoryMap.get(subdirectory.id);
            if (subdirectoryData) {
                subdirectoriesList.append(createDirectoryListItem(subdirectoryData, directoryMap));
            }
        });
        container.append(subdirectoriesList);
    }

    // If the directory has notes, create a list item for each note
    if (directory.notes && directory.notes.length > 0) {
        var notesList = $('<ul></ul>').addClass('nav');
        directory.notes.forEach(function(note) {
            var noteListItem = $('<li></li>').attr('id', 'note-' + note.id).addClass('note');
            var noteLink = $('<a></a>').attr('href', '#');

            noteLink.append($('<i></i>').addClass('fa-regular fa-file'));
            noteLink.append($('<span>').text(note.title));

            // Add a click event listener to the note link that calls note_detail with the note ID
            noteLink.on('click', function(e) {
                e.preventDefault();
                note_detail(note.id);

                // Highlight the note in the directory
                $('.note').removeClass('note-highlight');
                noteListItem.addClass('note-highlight');
            });

            noteLink.on('contextmenu', function(e) {
                e.preventDefault();

                let menu = $('<div></div>').addClass('dropdown-menu show').css({
                    position: 'absolute',
                    left: e.pageX,
                    top: e.pageY
                });

                menu.append($('<a></a>').addClass('dropdown-item').attr('href', '#').text('Copy link').on('click', function (e) {
                    e.preventDefault();
                    copy_object_link(note.id);
                }));

                menu.append($('<a></a>').addClass('dropdown-item').attr('href', '#').text('Copy MD link').on('click', function (e) {
                    e.preventDefault();
                    copy_object_link_md('notes',note.id);
                }));

                menu.append($('<a></a>').addClass('dropdown-item').attr('href', '#').text('Move').on('click', function (e) {
                    e.preventDefault();
                    move_item(note.id, 'note');
                }));

                menu.append($('<div></div>').addClass('dropdown-divider'));
                menu.append($('<a></a>').addClass('dropdown-item text-danger').attr('href', '#').text('Delete').on('click', function (e) {
                    e.preventDefault();
                    delete_note(note.id, cid);
                }));

                $('body').append(menu).on('click', function() {
                    menu.remove();
                });

            });

            noteListItem.append(noteLink);
            notesList.append(noteListItem);
        });
        container.append(notesList);
    }

    return listItem;
}


function note_interval_pinger() {
    if (is_note_collab_active()) {
        return;
    }
    if (new Date() - last_ping > 2000) {
        collaborator_socket.emit('ping-note',
            { 'channel': 'case-' + get_caseid() + '-notes', 'note_id': note_id });
        last_ping = new Date();
    }
}

$(document).ready(function(){

    load_directories().then(
        function() {
            let shared_id = getSharedLink();
            if (shared_id) {
                note_detail(shared_id);
            }

            $('.page-aside').resizable({
                handles: 'e'
            });
        }
    )


    cid = get_caseid();
    collaborator_socket = io.connect();
    collaborator_socket.emit('join-notes-overview', { 'channel': 'case-' + cid + '-notes' });

    collaborator_socket.on('ping-note', function(data) {
        if (is_note_collab_active()) {
            return;
        }
        last_ping = new Date();

        // Set as int to avoid type mismatch
        if (parseInt(data.note_id) !== parseInt(note_id)) return;

        ppl_viewing.set(data.user, 1);
        for (let [key, value] of ppl_viewing) {
            if (key !== data.user) {
                ppl_viewing.set(key, value-1);
            }
            if (value < 0) {
                ppl_viewing.delete(key);
            }
        }
        refresh_ppl_list(session_id, note_id);
    });

    timer_socket = setInterval( function() {
        note_interval_pinger();
    }, 2000);

    if (!is_note_collab_active()) {
        collaborator_socket.emit('ping-note', { 'channel': 'case-' + cid + '-notes', 'note_id': note_id });
    }

    setInterval(auto_remove_typing, 1500);

    const flush_active_collab_note = function() {
        flush_note_collab_leave_sync($('#currentNoteIDLabel').data('note_id'));
    };
    window.addEventListener('pagehide', flush_active_collab_note);
    window.addEventListener('beforeunload', flush_active_collab_note);

    $(document).on('click', '#currentNoteTitle', function() {
        let title = $(this).text();

        let input = $('<input>');
        input.attr('id', 'currentNoteTitleInput');
        input.attr('type', 'text');
        input.val(title);
        input.addClass('form-control');

        $(this).replaceWith(input);

        $('#currentNoteTitleInput').focus();
    });

    $(document).on('blur', '#currentNoteTitleInput', function(e) {
        let title = $(this).val();

        let h4 = $('<h4>');
        h4.attr('id', 'currentNoteTitle');
        h4.addClass('page-title mb-0');
        h4.text(title);

        $(this).replaceWith(h4);

        save_note();
    });

    $('#search-input').keyup(function() {
        let searchInput = $(this).val();
        fetchNotes(searchInput);
    });

    $('#clear-search').on('click', function() {
        // Clear the search input field
        $('#search-input').val('');

        $('.directory-container').find('li').show();
        $('.directory').show();
        $('.note').show();
    });

});
