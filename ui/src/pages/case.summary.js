import crc32 from '$lib/utils/crc32';
import { hashContent, getCollabUser, syncPostJson, waitForSplitEditor } from '$lib/collab_editor_session';

let collaborator = null;
let summary_split = null;
let summary_opening = false;
let summary_applying_remote = false;
let summary_dirty = false;
let summary_save_timer = null;
let summary_current_markdown = '';
let summary_collab_active_until = 0;
let summary_collab_persist_timer = null;
let summary_collab_last_persist_hash = null;
let is_typing = '';

const SUMMARY_AUTOSAVE_MS = 2000;
const SUMMARY_COLLAB_PERSIST_DEBOUNCE_MS = 4000;
const SUMMARY_COLLAB_WINDOW_MS = 15000;
const SUMMARY_SPLIT_EDITOR_LOAD_TIMEOUT_MS = 10000;

function is_summary_collab_active() {
    return !!(summary_split
        && typeof summary_split.isCollabActive === 'function'
        && summary_split.isCollabActive());
}

function clear_summary_collab_timers() {
    if (summary_collab_persist_timer) {
        clearTimeout(summary_collab_persist_timer);
        summary_collab_persist_timer = null;
    }
}

function reset_summary_collab_state(markdown) {
    clear_summary_collab_timers();
    summary_collab_last_persist_hash = hashContent(markdown || '');
}

function summary_collab_payload(markdown) {
    return {
        csrf_token: $('#csrf_token').val(),
        case_description: markdown || '',
        client_hash: hashContent(markdown || ''),
    };
}

function mark_summary_collab_persisted(hash, data) {
    summary_collab_last_persist_hash = hash;
    summary_dirty = false;
    if (data && data.data && data.data.crc32 !== undefined) {
        $('#fetched_crc').val(data.data.crc32.toString());
    }
    set_saved_status('Changes saved', true);
    $('#content_last_sync').text('Last synced: ' + new Date().toLocaleTimeString());
    $('#content_last_saved_by').text('Last persisted by you');
}

function summary_collab_persist(markdown, options = {}) {
    const md = markdown !== undefined ? markdown : get_active_summary_markdown();
    const hash = hashContent(md);
    if (!options.force && hash === summary_collab_last_persist_hash) {
        return Promise.resolve({ skipped: true, hash });
    }

    return new Promise((resolve, reject) => {
        post_request_api(
            '/case/summary/collab/persist',
            JSON.stringify(summary_collab_payload(md)),
            false,
            undefined,
            get_caseid()
        )
        .done((data) => {
            if (api_request_failed(data)) {
                reject(data);
                return;
            }
            summary_current_markdown = md;
            render_summary_preview(md);
            mark_summary_collab_persisted(hash, data);
            resolve({ skipped: false, hash, data });
        })
        .fail(reject);
    });
}

function schedule_summary_collab_persist() {
    if (summary_collab_persist_timer) {
        clearTimeout(summary_collab_persist_timer);
    }
    summary_collab_persist_timer = setTimeout(() => {
        summary_collab_persist_timer = null;
        summary_collab_persist().catch(() => {
            set_saved_status('Error saving !', false);
        });
    }, SUMMARY_COLLAB_PERSIST_DEBOUNCE_MS);
}

function summary_collab_sync_post(markdown) {
    return syncPostJson('/case/summary/collab/persist', summary_collab_payload(markdown), get_caseid());
}

function summary_sync_post(markdown) {
    return syncPostJson('/case/summary/update', {
        case_description: markdown,
        csrf_token: $('#csrf_token').val(),
    }, get_caseid());
}

async function flush_summary_collab_before_close(markdown) {
    clear_summary_collab_timers();
    if (!is_summary_collab_active()) {
        return;
    }
    await summary_collab_persist(markdown, { force: true }).catch(() => {});
}

function wait_for_split_editor() {
    return waitForSplitEditor({
        timeoutMs: SUMMARY_SPLIT_EDITOR_LOAD_TIMEOUT_MS,
        onTimeout: () => notify_error('GUI editor failed to load'),
    });
}

function Collaborator(session_id) {
    this.collaboration_socket = io.connect();
    this.channel = 'case-' + session_id;
    this.collaboration_socket.emit('join', { 'channel': this.channel });

    this.collaboration_socket.on('change', function(data) {
        if (is_summary_collab_active()) {
            return;
        }
        summary_collab_active_until = Date.now() + SUMMARY_COLLAB_WINDOW_MS;
        if (summary_save_timer) {
            clearTimeout(summary_save_timer);
            summary_save_timer = null;
        }
        if (data && data.last_change) {
            $('#content_typing').text(data.last_change + ' is typing..');
        }
    });

    this.collaboration_socket.on('clear_buffer', function() {
        if (is_summary_collab_active()) {
            return;
        }
        summary_collab_active_until = Date.now() + SUMMARY_COLLAB_WINDOW_MS;
        if (summary_save_timer) {
            clearTimeout(summary_save_timer);
            summary_save_timer = null;
        }
        sync_editor(true).catch(function() {});
    });

    this.collaboration_socket.on('save', function(data) {
        if (is_summary_collab_active()) {
            return;
        }
        $('#content_last_saved_by').text('Last saved by ' + data.last_saved);
        sync_editor(true).catch(function() {});
    });
}

Collaborator.prototype.save = function() {
    this.collaboration_socket.emit('save', { 'channel': this.channel });
};

function body_loaded() {
    collaborator = new Collaborator(get_caseid());
}

function report_template_selector() {
    $('#modal_select_report').modal({ show: true });
}

function gen_report(safe) {
    let url = '/case/report/generate-investigation/' + $('#select_report option:selected').val() + case_param();
    if (safe === true) {
        url += '&safe=true';
    }
    window.open(url, '_blank');
}

function gen_act_report(safe) {
    let url = '/case/report/generate-activities/' + $('#select_report_act option:selected').val() + case_param();
    if (safe === true) {
        url += '&safe=true';
    }
    window.open(url, '_blank');
}

function act_report_template_selector() {
    $('#modal_select_report_act').modal({ show: true });
}

function render_summary_preview(markdown) {
    const target = document.getElementById('targetDiv');
    if (!target) {
        return;
    }
    const converter = get_showdown_convert();
    const html = converter.makeHtml(do_md_filter_xss(markdown || ''));
    target.innerHTML = do_md_filter_xss(html);
}

function set_saved_status(text, saved) {
    $('#last_saved')
        .text(text)
        .toggleClass('badge-success', !!saved)
        .toggleClass('badge-danger', !saved);
}

function reset_saved_status() {
    $('#last_saved')
        .text('')
        .removeClass('badge-success badge-danger');
}

function get_active_summary_markdown() {
    if (summary_split) {
        summary_current_markdown = summary_split.getMarkdown();
        return summary_current_markdown;
    }
    return summary_current_markdown || '';
}

function apply_remote_summary(md, force) {
    const markdown = md || '';
    if (summary_split && summary_dirty && !force) {
        notify_error('This summary was just changed by someone else. Your unsaved changes are kept. Save again to resolve the conflict.');
        return false;
    }

    summary_applying_remote = true;
    summary_dirty = false;
    summary_current_markdown = markdown;
    render_summary_preview(markdown);

    if (summary_split) {
        summary_split.setMarkdown(markdown);
        window.setTimeout(function() {
            summary_applying_remote = false;
        }, 0);
    } else {
        summary_applying_remote = false;
    }
    return true;
}

function schedule_summary_autosave() {
    if (summary_save_timer) {
        clearTimeout(summary_save_timer);
    }
    summary_save_timer = setTimeout(function() {
        summary_save_timer = null;
        if (Date.now() < summary_collab_active_until) {
            set_saved_status('Not saved (others editing)', false);
            return;
        }
        sync_editor(false).catch(function() {});
    }, SUMMARY_AUTOSAVE_MS);
}

function on_summary_split_change(md) {
    if (summary_applying_remote) {
        return;
    }
    summary_current_markdown = md || '';
    summary_dirty = true;
    if (is_summary_collab_active()) {
        set_saved_status('Changes not saved', false);
        schedule_summary_collab_persist();
        return;
    }
    if (Date.now() < summary_collab_active_until) {
        set_saved_status('Not saved (others editing)', false);
        return;
    }
    set_saved_status('Changes not saved', false);
    schedule_summary_autosave();
}

async function open_summary_split() {
    if (summary_split || summary_opening) {
        return;
    }
    summary_opening = true;
    try {
        await wait_for_split_editor();
        summary_applying_remote = true;
        summary_dirty = false;
        reset_summary_collab_state(summary_current_markdown || '');
        const split_options = {
            container: '#summary_split',
            sourcePane: '#summary_source',
            previewPane: '#summary_preview',
            divider: '#summary_divider',
            viewToggle: '#summary_view_toggle',
            initialMarkdown: summary_current_markdown || '',
            onChange: on_summary_split_change,
            collab: {
                room: 'summary-' + get_caseid(),
                user: getCollabUser(),
                presenceTarget: '#content_typing',
                onStatus: function(status) {
                    $('#summary_split').attr('data-collab-status', status || '');
                },
            },
        };
        try {
            summary_split = await window.IrisSplitEditor.create(split_options);
        } catch (collab_error) {
            delete split_options.collab;
            summary_split = await window.IrisSplitEditor.create(split_options);
        }
        $('#ctrd_casesum').hide();
        $('#summary_split_container').show();
        $('#sum_refresh_btn').html('Refresh').addClass('d-none').hide();
        $('#sum_edit_btn').html('Close editor');
        summary_split.focus();
    } catch (e) {
        return;
    } finally {
        summary_applying_remote = false;
        summary_opening = false;
    }
}

async function close_summary_split() {
    if (!summary_split) {
        return;
    }
    if (summary_save_timer) {
        clearTimeout(summary_save_timer);
        summary_save_timer = null;
    }

    summary_current_markdown = summary_split.getMarkdown();
    render_summary_preview(summary_current_markdown);
    try {
        if (is_summary_collab_active()) {
            await flush_summary_collab_before_close(summary_current_markdown);
        } else {
            await sync_editor(false);
        }
    } catch (e) {
        return;
    }
    await summary_split.destroy();
    summary_split = null;
    summary_dirty = false;
    clear_summary_collab_timers();
    $('#summary_split').removeAttr('data-collab-status');

    $('#summary_split_container').hide();
    $('#ctrd_casesum').show();
    $('#sum_refresh_btn').html('Refresh').removeClass('d-none').show();
    $('#sum_edit_btn').html('Edit');
}

async function edit_case_summary() {
    if (summary_split || summary_opening) {
        await close_summary_split();
    } else {
        await open_summary_split();
    }
}

/* sync_editor
 * Save the editor state.
 * Check if there are external changes first.
 */
function sync_editor(no_check) {
    if (is_summary_collab_active()) {
        set_saved_status('Syncing..', false);
        clear_summary_collab_timers();
        return summary_collab_persist(undefined, { force: true });
    }

    set_saved_status('Syncing..', false);

    return get_request_api('/case/summary/fetch')
        .catch((error) => {
            reset_saved_status();
            notify_error((error.responseJSON && error.responseJSON.message) || error.message || 'Failed to fetch summary');
            throw error;
        })
        .then((data) => {
            if (data.status !== 'success') {
                reset_saved_status();
                notify_error(data.message || 'Failed to fetch summary');
                throw new Error(data.message || 'Failed to fetch summary');
            }

            if (no_check) {
                const applied = apply_remote_summary(data.data.case_description);
                if (applied) {
                    $('#fetched_crc').val(data.data.crc32.toString());
                    set_saved_status('Changes saved', true);
                    $('#content_last_sync').text('Last synced: ' + new Date().toLocaleTimeString());
                }
                return;
            }

            const st = get_active_summary_markdown();
            const fetched_crc = $('#fetched_crc').val();

            if (data.data.crc32.toString() !== fetched_crc) {
                const local_crc = crc32(st).toString();
                if (local_crc === fetched_crc) {
                    apply_remote_summary(data.data.case_description);
                    $('#fetched_crc').val(data.data.crc32);
                    set_saved_status('Changes saved', true);
                    $('#content_last_sync').text('Last synced: ' + new Date().toLocaleTimeString());
                } else {
                    const local_content = st;
                    set_saved_status('Conflict !', false);
                    return swal(
                        'Oh no !',
                        'We have a conflict with the remote content.\nSomeone may just have changed the description at the same time.\nThe local content will be copied into clipboard and content will be updated with remote.',
                        'error'
                    ).then(() => {
                        try {
                            if (navigator.clipboard) {
                                navigator.clipboard.writeText(local_content);
                            }
                        } catch (e) { /* clipboard may be unavailable; remote still applies */ }
                        apply_remote_summary(data.data.case_description, true);
                        $('#fetched_crc').val(data.data.crc32);
                        set_saved_status('Changes saved', true);
                        notify_success('Content updated with remote. Local changes copied to clipboard.');
                        $('#content_last_sync').text('Last synced: ' + new Date().toLocaleTimeString());
                    });
                }
                return;
            }

            const local_crc = crc32(st).toString();
            if (local_crc === fetched_crc) {
                set_saved_status('Changes saved', true);
                $('#content_last_sync').text('Last synced: ' + new Date().toLocaleTimeString());
                return;
            }

            const payload = {
                case_description: st,
                csrf_token: $('#csrf_token').val(),
            };

            return new Promise((resolve, reject) => {
                $.ajax({
                    url: '/case/summary/update' + case_param(),
                    type: 'POST',
                    dataType: 'json',
                    contentType: 'application/json;charset=UTF-8',
                    data: JSON.stringify(payload),
                    success: function(update_data) {
                        if (update_data.status === 'success') {
                            if (collaborator) {
                                collaborator.save();
                            }
                            summary_dirty = false;
                            summary_current_markdown = st;
                            render_summary_preview(st);
                            $('#content_last_sync').text('Last synced: ' + new Date().toLocaleTimeString());
                            $('#fetched_crc').val(update_data.data);
                            set_saved_status('Changes saved', true);
                            resolve(update_data);
                        } else {
                            const message = update_data.message || 'Unable to save content to remote server';
                            notify_error(message);
                            set_saved_status('Error saving !', false);
                            reject(new Error(message));
                        }
                    },
                    error: function(error) {
                        const message = (error.responseJSON && error.responseJSON.message) || 'Failed to save summary';
                        notify_error(message);
                        set_saved_status('Error saving !', false);
                        reject(error || new Error(message));
                    },
                });
            });
        });
}

function auto_remove_typing() {
    if (is_summary_collab_active()) {
        $('#content_typing').text('');
        return;
    }
    if ($('#content_typing').text() === is_typing) {
        $('#content_typing').text('');
    } else {
        is_typing = $('#content_typing').text();
    }
}

function case_pipeline_popup() {
    const url = '/case/pipelines-modal' + case_param();
    $('#info_case_modal_content').load(url, function(response, status, xhr) {
        if (status !== 'success') {
             ajax_notify_error(xhr, url);
             return false;
        }
        $('#modal_case_detail').modal({ show: true });
        $('#update_pipeline_selector').selectpicker({
            liveSearch: true,
            style: 'btn-outline-white',
            });
        $('#update_pipeline_selector').selectpicker('refresh');
        $('.control-update-pipeline-args ').hide();
        $('.control-update-pipeline-' + $('#update_pipeline_selector').val()).show();
        $('#update_pipeline_selector').on('change', function() {
          $('.control-update-pipeline-args ').hide();
          $('.control-update-pipeline-' + this.value).show();
        });
        $('[data-toggle="popover"]').popover();
    });
}

async function do_case_review(action, reviewer_id) {
    const data = {};
    data['csrf_token'] = $('#csrf_token').val();
    data['action'] = action;
    if (reviewer_id) {
        data['reviewer_id'] = reviewer_id;
    }

    return post_request_api('/case/review/update', JSON.stringify(data));
}

function case_detail(case_id, edit_mode=false) {
    const url = '/case/details/' + case_id + case_param();
    $('#info_case_modal_content').load(url, function(response, status, xhr) {
        if (status !== 'success') {
             ajax_notify_error(xhr, url);
             return false;
        }
        $('#modal_case_detail').modal({ show: true });
        if (edit_mode) {
            edit_case_info();
        }

        $('#modal_case_detail').off('hide.bs.modal').on('hide.bs.modal', function() {
            location.reload();
        });
    });
}

function manage_case(case_id) {
   window.location = '/manage/cases?cid=' + case_id + '#view';
}

$(document).ready(function() {
    body_loaded();
    sync_editor(true).catch(function() {});
    setInterval(auto_remove_typing, 2000);
    window.addEventListener('beforeunload', function() {
        if (is_summary_collab_active()) {
            summary_collab_sync_post(get_active_summary_markdown());
            return;
        }
        if (summary_dirty) {
            summary_sync_post(get_active_summary_markdown());
        }
    });

    const review_state = $('#caseReviewState');
    if (review_state.length > 0) {
        const current_review_state = review_state.data('review-state');

        if (current_review_state === 'Review in progress') {
            $('.btn-start-review').hide();
            $('.btn-confirm-review').show();
            $('.btn-cancel-review').show();
            $('#reviewSubtitle').text('You started this review. Press "Confirm review" when you are done.');
        } else if (current_review_state === 'Review completed') {
            $('.btn-start-review').hide();
            $('.btn-confirm-review').hide();
            $('.btn-cancel-review').hide();
        } else if (current_review_state === 'Pending review') {
            $('.btn-start-review').show();
            $('.btn-confirm-review').hide();
            $('.btn-cancel-review').hide();
        }
        $('.review-card').show();
    }

    $('.btn-start-review').on('click', function() {
        do_case_review('start').then(function(data) {
            if (notify_auto_api(data)) {
                location.reload();
            }
        });
    });

     $('.btn-confirm-review').on('click', function() {
        do_case_review('done').then(function(data) {
            if (notify_auto_api(data)) {
                location.reload();
            }
        });
     });

     $('.btn-cancel-review').on('click', function() {
        do_case_review('cancel').then(function(data) {
            if (notify_auto_api(data)) {
                location.reload();
            }
        });
     });

     $('#request_review').on('click', function() {
        const reviewer_id = $('#caseReviewState').data('reviewer-id');
        const reviewer_name = $('#caseReviewState').data('reviewer-name');

        if (reviewer_id !== 'None') {
            swal({
                title: 'Request review',
                text: 'Request a case review from ' + reviewer_name + '?',
                icon: 'info',
                buttons: true,
                dangerMode: false,
            }).then((willRequest) => {
                if (willRequest) {
                    do_case_review('request', reviewer_id).then(function(data) {
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
                width: '100%',
            });
            get_request_api('/case/users/list')
            .done((data) => {
                if (notify_auto_api(data)) {
                    const users = data.data;
                    let options = '';
                    for (let i = 0; i < users.length; i++) {
                        if (users[i].user_access_level === 4) {
                            options += '<option value="' + users[i].user_id + '">' + filterXSS(users[i].user_name) + '</option>';
                        }
                    }
                    $('#reviewer_id').html(options);
                    $('#reviewer_id').selectpicker('refresh');
                    $('#modal_choose_reviewer').modal('show');

                    $('#submit_set_reviewer').off('click').on('click', function() {
                        const selected_reviewer_id = $('#reviewer_id').val();
                        do_case_review('request', selected_reviewer_id).then(function(update_data) {
                            if (notify_auto_api(update_data)) {
                                location.reload();
                            }
                        });
                    });
                }
            });
        }
     });
});
