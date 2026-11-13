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

// Zestaw ID węzłów aktualnie rozwiniętych przez użytkownika w trakcie sesji
const expandedNodeIds = new Set();

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
// TWORZENIE NOWEJ HISTORII (WYWOŁANIE EDGE FUNCTION 'quick-api' / game-master)
// ============================================================================
document.getElementById('btn-confirm-create-story').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-create-story');
    const theme = document.getElementById('story-theme-input').value.trim();

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Mistrz Gry pisze sprawę...';

    try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/quick-api`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({
                action: 'create_story',
                theme: theme,
                created_by: state.currentUser.id
            })
        });

        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || `Błąd serwera (${response.status})`);
        }

        const modal = bootstrap.Modal.getInstance(document.getElementById('newStoryModal'));
        modal.hide();
        document.getElementById('story-theme-input').value = '';

        await loadDashboardData();
        if (data?.story?.id) {
            await openStory(data.story.id);
        }
    } catch (err) {
        alert('Nie udało się wygenerować historii: ' + err.message);
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

    // Resetujemy rozwinięte karty przy wejściu do sprawy, aby wszystkie były domyślnie zwinięte
    expandedNodeIds.clear();
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
        const stepNumber = index + 1;
        const isExpanded = expandedNodeIds.has(node.id);

        // Plakietka statusu widoczna od razu na zwiniętym pasku
        let badgeHtml = '';
        if (node.visibility === 'private') {
            badgeHtml = '<span class="badge bg-dark border border-secondary text-secondary"><i class="bi bi-lock-fill me-1"></i>Prywatne</span>';
        } else if (node.visibility === 'spoiler_clue') {
            badgeHtml = '<span class="badge bg-warning text-dark"><i class="bi bi-lightbulb-fill me-1"></i>Wskazówka</span>';
        } else if (node.visibility === 'spoiler_solution') {
            badgeHtml = '<span class="badge bg-danger"><i class="bi bi-bullseye me-1"></i>Rozwiązanie</span>';
        }

        // Panel oznaczania po fakcie (tylko dla autora danego pytania, widoczny po rozwinięciu)
        const ownerControlsHtml = isMine ? `
            <div class="d-flex flex-wrap align-items-center gap-1 mt-2 pt-2 border-top border-secondary-subtle">
                <span class="text-secondary me-1" style="font-size: 0.72rem;">Oznacz wpis:</span>
                <button class="btn btn-sm py-0 px-2 ${node.visibility === 'public' ? 'btn-secondary' : 'btn-outline-secondary'}" style="font-size: 0.72rem;" onclick="updateNodeVisibility('${node.id}', 'public')">
                    Zwykły
                </button>
                <button class="btn btn-sm py-0 px-2 ${node.visibility === 'spoiler_clue' ? 'btn-warning text-dark fw-semibold' : 'btn-outline-warning'}" style="font-size: 0.72rem;" onclick="updateNodeVisibility('${node.id}', 'spoiler_clue')">
                    💡 Wskazówka
                </button>
                <button class="btn btn-sm py-0 px-2 ${node.visibility === 'spoiler_solution' ? 'btn-danger fw-semibold' : 'btn-outline-danger'}" style="font-size: 0.72rem;" onclick="updateNodeVisibility('${node.id}', 'spoiler_solution')">
                    🎯 Rozwiązanie
                </button>
                <button class="btn btn-sm py-0 px-2 ${node.visibility === 'private' ? 'btn-dark border-light' : 'btn-outline-secondary'}" style="font-size: 0.72rem;" onclick="updateNodeVisibility('${node.id}', 'private')">
                    🔒 Tylko dla mnie
                </button>
            </div>
        ` : '';

        // Czy karta może zostać rozwinięta przez zalogowanego użytkownika (cudzych wpisów 'private' nie da się rozwinąć)
        const isLockedPrivateForMe = !isMine && node.visibility === 'private';

        const expandableBodyHtml = isLockedPrivateForMe
            ? `<div id="node-secret-body-${node.id}" class="${isExpanded ? '' : 'd-none'} mt-2 pt-2 border-top border-secondary-subtle small text-secondary fst-italic">
                   <i class="bi bi-shield-lock me-1"></i>Wpis prywatny autora (${escapeHtml(author.username)}). Możesz użyć „Rozwidlij stąd”, aby poprowadzić własną ścieżkę.
               </div>`
            : `<div id="node-secret-body-${node.id}" class="${isExpanded ? '' : 'd-none'} mt-2 pt-2 border-top border-secondary-subtle">
                   <p class="mb-2 fw-semibold text-info-emphasis small">Pytanie: ${escapeHtml(node.question_text)}</p>
                   <div class="border-top border-secondary-subtle pt-2 small">
                       <span class="text-danger fw-bold me-1">AI:</span> <span class="text-light">${escapeHtml(node.ai_answer_text)}</span>
                   </div>
                   ${ownerControlsHtml}
               </div>`;

        return `
            <div class="card node-card ${isSelectedParent ? 'is-active-parent' : ''}">
                <div class="card-body py-2 px-3">
                    <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                        <div class="d-flex align-items-center gap-2 flex-grow-1" style="cursor: pointer;" onclick="toggleNodeReveal('${node.id}')">
                            <span class="avatar-dot" style="background-color: ${author.avatar_color};">${author.username[0]}</span>
                            <strong class="small text-light">${escapeHtml(author.username)} — Pytanie #${stepNumber}</strong>
                            ${badgeHtml}
                            <i id="node-chevron-${node.id}" class="bi ${isExpanded ? 'bi-chevron-up' : 'bi-chevron-down'} text-secondary small ms-1"></i>
                        </div>
                        <button class="btn btn-outline-info btn-sm py-0 px-2" style="font-size: 0.75rem;" onclick="forkFromNode('${node.id}')" title="Kontynuuj śledztwo od tego momentu (Git Fork)">
                            <i class="bi bi-diagram-2"></i> Rozwidlij stąd
                        </button>
                    </div>
                    ${expandableBodyHtml}
                </div>
            </div>
        `;
    }).join('');
}

// Rozwijanie / zwijanie dowolnej karty pytania i odpowiedzi po kliknięciu w nagłówek
window.toggleNodeReveal = function(nodeId) {
    const bodyEl = document.getElementById(`node-secret-body-${nodeId}`);
    const chevronEl = document.getElementById(`node-chevron-${nodeId}`);
    if (!bodyEl) return;

    const willExpand = bodyEl.classList.contains('d-none');
    bodyEl.classList.toggle('d-none');

    if (willExpand) {
        expandedNodeIds.add(nodeId);
    } else {
        expandedNodeIds.delete(nodeId);
    }

    if (chevronEl) {
        chevronEl.className = willExpand
            ? 'bi bi-chevron-up text-secondary small ms-1'
            : 'bi bi-chevron-down text-secondary small ms-1';
    }
};

// Zmiana oznaczenia wpisu (Zwykły / Wskazówka / Rozwiązanie / Prywatne) po poznaniu odpowiedzi AI
window.updateNodeVisibility = async function(nodeId, newVisibility) {
    const { error } = await supabaseClient
        .from('ch_nodes')
        .update({ visibility: newVisibility })
        .eq('id', nodeId);

    if (error) {
        alert('Nie udało się zaktualizować oznaczenia: ' + error.message);
        return;
    }

    const targetNode = state.currentNodes.find(n => n.id === nodeId);
    if (targetNode) {
        targetNode.visibility = newVisibility;
    }
    renderNodesTimeline();
};

// Rozwidlanie ścieżki śledztwa (Git Fork)
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
    expandedNodeIds.clear();
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
        const response = await fetch(`${SUPABASE_URL}/functions/v1/quick-api`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({
                action: 'ask_question',
                story_id: state.currentStory.id,
                parent_node_id: state.activeLeafNodeId,
                author_id: state.currentUser.id,
                question_text: questionText,
                visibility: visibility
            })
        });

        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || `Błąd serwera (${response.status})`);
        }

        input.value = '';
        if (data?.node?.id) {
            state.activeLeafNodeId = data.node.id;
            expandedNodeIds.add(data.node.id);
        }
        await syncStoryNodes();
    } catch (err) {
        alert('Błąd komunikacji z Mistrzem Gry AI: ' + err.message);
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