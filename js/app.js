// ============================================================================
// KONFIGURACJA SUPABASE I STAN GLOBALNY
// ============================================================================
const SUPABASE_URL = 'https://mkysisoznxgssakcegbn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4lljAeNc5dvmsJG2u1-pgQ_zCnATIE1';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const STORAGE_KEYS = {
    USER: 'ch_current_user',
    ACTIVE_STORY: 'ch_active_story_id'
};

let state = {
    currentUser: null,
    usersMap: {},
    stories: [],
    userStatesMap: {},
    currentStory: null,
    currentNodes: [],
    activeLeafNodeId: null, // Węzeł, od którego kontynuujemy (mechanika Git-fork)
    storyFilter: 'active'
};

// ============================================================================
// ROUTING SPA (SEKWENCJA: SPLASH -> LOGIN -> DASHBOARD -> STORY)
// ============================================================================
function switchTab(tabId) {
    document.querySelectorAll('.app-tab').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(tabId);
    if (target) target.classList.add('active');
}

async function initApp() {
    // 1. Pobierz listę użytkowników do mapy kolorów i ekranu logowania
    await loadUsers();

    // 2. Sprawdź zapamiętaną sesję (niewylogowywalne konta)
    const savedUserJson = localStorage.getItem(STORAGE_KEYS.USER);
    setTimeout(async () => {
        if (savedUserJson) {
            try {
                state.currentUser = JSON.parse(savedUserJson);
                updateUserBadge();
                await loadDashboardData();
                switchTab('tab-dashboard');
                return;
            } catch (e) {
                localStorage.removeItem(STORAGE_KEYS.USER);
            }
        }
        switchTab('tab-login');
    }, 900); // Krótki splash screen
}

// ============================================================================
// LOGOWANIE I UŻYTKOWNICY
// ============================================================================
async function loadUsers() {
    const { data, error } = await supabaseClient
        .from('ch_users')
        .select('id, username, avatar_color')
        .order('username', { ascending: true });

    if (error) {
        console.error('Błąd pobierania użytkowników:', error);
        return;
    }

    const select = document.getElementById('login-username');
    select.innerHTML = '<option value="" disabled selected>Wybierz swoje imię...</option>';

    data.forEach(u => {
        state.usersMap[u.id] = u;
        const opt = document.createElement('option');
        opt.value = u.username;
        opt.textContent = u.username;
        select.appendChild(opt);
    });
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value.trim();
    const errorBox = document.getElementById('login-error');

    errorBox.classList.add('d-none');

    const { data, error } = await supabaseClient
        .from('ch_users')
        .select('id, username, avatar_color')
        .eq('username', username)
        .eq('password', password)
        .single();

    if (error || !data) {
        errorBox.textContent = 'Nieprawidłowe hasło. Wpisz swoje imię małymi literami.';
        errorBox.classList.remove('d-none');
        return;
    }

    state.currentUser = data;
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data));
    updateUserBadge();
    await loadDashboardData();
    switchTab('tab-dashboard');
});

document.getElementById('btn-logout').addEventListener('click', () => {
    if (confirm('Czy na pewno chcesz zmienić profil użytkownika na tym urządzeniu?')) {
        localStorage.removeItem(STORAGE_KEYS.USER);
        state.currentUser = null;
        document.getElementById('login-password').value = '';
        switchTab('tab-login');
    }
});

function updateUserBadge() {
    const badge = document.getElementById('current-user-badge');
    if (!state.currentUser) return;
    badge.textContent = state.currentUser.username;
    badge.style.backgroundColor = state.currentUser.avatar_color;
}

// ============================================================================
// DASHBOARD (LISTA HISTORII + STATUSY INDYWIDUALNE)
// ============================================================================
async function loadDashboardData() {
    const listContainer = document.getElementById('stories-list');
    listContainer.innerHTML = '<div class="text-center text-secondary py-4"><div class="spinner-border spinner-border-sm text-danger"></div></div>';

    const [{ data: stories, error: sErr }, { data: userStates }] = await Promise.all([
        supabaseClient
            .from('ch_stories')
            .select('id, title, public_intro, created_by, created_at')
            .order('created_at', { ascending: false }),
        supabaseClient
            .from('ch_user_story_states')
            .select('*')
            .eq('user_id', state.currentUser.id)
    ]);

    if (sErr) {
        listContainer.innerHTML = `<div class="alert alert-danger">Błąd ładowania spraw: ${sErr.message}</div>`;
        return;
    }

    state.stories = stories || [];
    state.userStatesMap = {};
    (userStates || []).forEach(st => {
        state.userStatesMap[st.story_id] = st;
    });

    renderStoriesList();
}

function renderStoriesList() {
    const listContainer = document.getElementById('stories-list');
    let activeCount = 0;
    let completedCount = 0;

    state.stories.forEach(s => {
        const isDone = state.userStatesMap[s.id]?.is_completed === true;
        if (isDone) completedCount++;
        else activeCount++;
    });

    document.getElementById('count-active').textContent = activeCount;
    document.getElementById('count-completed').textContent = completedCount;

    const filtered = state.stories.filter(s => {
        const isDone = state.userStatesMap[s.id]?.is_completed === true;
        return state.storyFilter === 'completed' ? isDone : !isDone;
    });

    if (filtered.length === 0) {
        listContainer.innerHTML = `
            <div class="text-center text-secondary py-5 border border-secondary-subtle rounded-3">
                <i class="bi bi-folder2-open fs-2 d-block mb-2"></i>
                <p class="small mb-0">Brak spraw w tej zakładce.</p>
            </div>`;
        return;
    }

    listContainer.innerHTML = filtered.map(story => {
        const author = state.usersMap[story.created_by]?.username || 'System';
        const dateStr = new Date(story.created_at).toLocaleDateString('pl-PL');
        return `
            <div class="card story-card shadow-sm" onclick="openStory('${story.id}')">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start mb-1">
                        <h3 class="h6 fw-bold mb-0 text-light">${escapeHtml(story.title)}</h3>
                        <span class="badge bg-secondary-subtle text-secondary-emphasis">${dateStr}</span>
                    </div>
                    <p class="small text-secondary text-truncate mb-2">${escapeHtml(story.public_intro)}</p>
                    <div class="d-flex justify-content-between align-items-center small text-secondary">
                        <span><i class="bi bi-person me-1"></i>Założył(a): ${escapeHtml(author)}</span>
                        <span class="text-danger fw-semibold">Otwórz akta <i class="bi bi-chevron-right"></i></span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

document.querySelectorAll('#stories-filter-pills .nav-link').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#stories-filter-pills .nav-link').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.storyFilter = btn.dataset.filter;
        renderStoriesList();
    });
});

document.getElementById('btn-refresh-stories').addEventListener('click', loadDashboardData);

// ============================================================================
// TWORZENIE NOWEJ HISTORII (WYWOŁANIE EDGE FUNCTION 'game-master')
// ============================================================================
document.getElementById('btn-confirm-create-story').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-create-story');
    const theme = document.getElementById('story-theme-input').value.trim();

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Mistrz Gry pisze sprawę...';

    try {
        const { data, error } = await supabaseClient.functions.invoke('game-master', {
            body: {
                action: 'create_story',
                theme: theme,
                created_by: state.currentUser.id
            }
        });

        if (error) throw error;

        const modal = bootstrap.Modal.getInstance(document.getElementById('newStoryModal'));
        modal.hide();
        document.getElementById('story-theme-input').value = '';

        await loadDashboardData();
        if (data?.story?.id) {
            await openStory(data.story.id);
        }
    } catch (err) {
        alert('Nie udało się wygenerować historii (upewnij się, że wdrożyliśmy Edge Function "game-master"): ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-stars me-1"></i>Generuj zagadkę';
    }
});

// ============================================================================
// WIDOK ŚLEDZTWA, SYNCHRONIZACJA I DRZEWO PYTAŃ (GIT-FORK)
// ============================================================================
async function openStory(storyId) {
    state.currentStory = state.stories.find(s => s.id === storyId);
    if (!state.currentStory) return;

    document.getElementById('story-title').textContent = state.currentStory.title;
    document.getElementById('story-intro').textContent = state.currentStory.public_intro;
    document.getElementById('story-meta-date').textContent = new Date(state.currentStory.created_at).toLocaleDateString('pl-PL');

    updateCompleteButtonUI();
    switchTab('tab-story');
    await syncStoryNodes();
}

async function syncStoryNodes() {
    const btn = document.getElementById('btn-sync-story');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sync...';

    const { data, error } = await supabaseClient
        .from('ch_nodes')
        .select('*')
        .eq('story_id', state.currentStory.id)
        .order('created_at', { ascending: true });

    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>Synchronizuj';

    if (error) {
        alert('Błąd synchronizacji: ' + error.message);
        return;
    }

    state.currentNodes = data || [];
    // Domyślnie ustawiamy koniec głównej osi czasu jako punkt zaczepienia, jeśli gracz nie wybrał forka
    if (!state.activeLeafNodeId && state.currentNodes.length > 0) {
        state.activeLeafNodeId = state.currentNodes[state.currentNodes.length - 1].id;
    }
    renderNodesTimeline();
}

function renderNodesTimeline() {
    const container = document.getElementById('nodes-timeline');
    const branchLabel = document.getElementById('branch-label');
    const resetBranchBtn = document.getElementById('btn-reset-branch');

    if (state.currentNodes.length === 0) {
        container.innerHTML = '<p class="text-center text-secondary small py-3">Brak pytań w tej sprawie. Zadaj pierwsze pytanie poniżej!</p>';
        branchLabel.textContent = 'Start śledztwa (Opis główny)';
        resetBranchBtn.classList.add('d-none');
        return;
    }

    const lastNode = state.currentNodes[state.currentNodes.length - 1];
    const isForked = state.activeLeafNodeId && state.activeLeafNodeId !== lastNode.id;

    if (isForked) {
        const idx = state.currentNodes.findIndex(n => n.id === state.activeLeafNodeId) + 1;
        branchLabel.innerHTML = `<span class="text-warning">Rozwidlenie od pytania #${idx}</span>`;
        resetBranchBtn.classList.remove('d-none');
    } else {
        branchLabel.textContent = 'Główna linia śledztwa (ostatni wpis)';
        resetBranchBtn.classList.add('d-none');
    }

    container.innerHTML = state.currentNodes.map((node, index) => {
        const author = state.usersMap[node.author_id] || { username: 'Gracz', avatar_color: '#6c757d' };
        const isMine = node.author_id === state.currentUser.id;
        const isSelectedParent = node.id === state.activeLeafNodeId;

        // Obsługa ukrywania / spoilerów
        let isHiddenForMe = false;
        let badgeHtml = '';

        if (node.visibility === 'private') {
            badgeHtml = '<span class="badge bg-dark border border-secondary text-secondary"><i class="bi bi-lock-fill me-1"></i>Prywatne</span>';
            if (!isMine) isHiddenForMe = true;
        } else if (node.visibility === 'spoiler_clue') {
            badgeHtml = '<span class="badge bg-warning text-dark"><i class="bi bi-lightbulb-fill me-1"></i>Wskazówka</span>';
            if (!isMine) isHiddenForMe = true;
        } else if (node.visibility === 'spoiler_solution') {
            badgeHtml = '<span class="badge bg-danger"><i class="bi bi-bullseye me-1"></i>Rozwiązanie</span>';
            if (!isMine) isHiddenForMe = true;
        }

        const answerContent = isHiddenForMe
            ? `<div class="p-2 rounded bg-black bg-opacity-25 text-secondary small fst-italic spoiler-blur" onclick="this.classList.toggle('revealed')" title="Kliknij, aby odsłonić na własną odpowiedzialność">
                 [Ukryta odpowiedź gracza ${escapeHtml(author.username)} – kliknij, aby odsłonić] <br><span class="text-light">${escapeHtml(node.ai_answer_text)}</span>
               </div>`
            : `<div class="text-light">${escapeHtml(node.ai_answer_text)}</div>`;

        return `
            <div class="card node-card ${isSelectedParent ? 'is-active-parent' : ''}">
                <div class="card-body py-2 px-3">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <div class="d-flex align-items-center gap-2">
                            <span class="avatar-dot" style="background-color: ${author.avatar_color};">${author.username[0]}</span>
                            <strong class="small">${escapeHtml(author.username)}</strong>
                            <span class="text-secondary small">#${index + 1}</span>
                            ${badgeHtml}
                        </div>
                        <button class="btn btn-outline-info btn-sm py-0 px-2" style="font-size: 0.75rem;" onclick="forkFromNode('${node.id}')" title="Kontynuuj śledztwo od tego momentu (Git Fork)">
                            <i class="bi bi-diagram-2"></i> Rozwidlij stąd
                        </button>
                    </div>
                    <p class="mb-2 fw-semibold text-info-emphasis small">Pytanie: ${escapeHtml(node.question_text)}</p>
                    <div class="border-top border-secondary-subtle pt-2 small">
                        <span class="text-danger fw-bold me-1">AI:</span> ${answerContent}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

window.forkFromNode = function(nodeId) {
    state.activeLeafNodeId = nodeId;
    renderNodesTimeline();
    document.getElementById('question-input').focus();
};

document.getElementById('btn-reset-branch').addEventListener('click', () => {
    if (state.currentNodes.length > 0) {
        state.activeLeafNodeId = state.currentNodes[state.currentNodes.length - 1].id;
    } else {
        state.activeLeafNodeId = null;
    }
    renderNodesTimeline();
});

document.getElementById('btn-sync-story').addEventListener('click', syncStoryNodes);

document.getElementById('btn-back-dashboard').addEventListener('click', async () => {
    state.currentStory = null;
    state.activeLeafNodeId = null;
    await loadDashboardData();
    switchTab('tab-dashboard');
});

// Zadawanie pytania AI (wywołanie Edge Function)
document.getElementById('btn-send-question').addEventListener('click', async () => {
    const input = document.getElementById('question-input');
    const questionText = input.value.trim();
    const visibility = document.getElementById('visibility-select').value;
    const btn = document.getElementById('btn-send-question');

    if (!questionText) return;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Mistrz Gry analizuje akta...';

    try {
        const { data, error } = await supabaseClient.functions.invoke('game-master', {
            body: {
                action: 'ask_question',
                story_id: state.currentStory.id,
                parent_node_id: state.activeLeafNodeId,
                author_id: state.currentUser.id,
                question_text: questionText,
                visibility: visibility
            }
        });

        if (error) throw error;

        input.value = '';
        if (data?.node?.id) {
            state.activeLeafNodeId = data.node.id;
        }
        await syncStoryNodes();
    } catch (err) {
        alert('Błąd komunikacji z Mistrzem Gry AI (upewnij się, że wdrożyliśmy Edge Function "game-master"): ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-send me-2"></i>Zapytaj Mistrza Gry AI';
    }
});

// Indywidualne zamykanie / wznawianie historii
function updateCompleteButtonUI() {
    const btn = document.getElementById('btn-toggle-complete');
    const isDone = state.userStatesMap[state.currentStory.id]?.is_completed === true;
    if (isDone) {
        btn.className = 'btn btn-success btn-sm';
        btn.innerHTML = '<i class="bi bi-arrow-counterclockwise me-1"></i>Wznów sprawę';
    } else {
        btn.className = 'btn btn-outline-success btn-sm';
        btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Zakończ (dla mnie)';
    }
}

document.getElementById('btn-toggle-complete').addEventListener('click', async () => {
    const storyId = state.currentStory.id;
    const currentStatus = state.userStatesMap[storyId]?.is_completed === true;
    const newStatus = !currentStatus;

    const { error } = await supabaseClient
        .from('ch_user_story_states')
        .upsert({
            user_id: state.currentUser.id,
            story_id: storyId,
            is_completed: newStatus,
            updated_at: new Date().toISOString()
        });

    if (error) {
        alert('Nie udało się zmienić statusu sprawy: ' + error.message);
        return;
    }

    state.userStatesMap[storyId] = { ...(state.userStatesMap[storyId] || {}), is_completed: newStatus };
    updateCompleteButtonUI();
});

// Pomocnicza ochrona przed XSS
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

// Start aplikacji
document.addEventListener('DOMContentLoaded', initApp);