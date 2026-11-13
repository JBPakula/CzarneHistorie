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
    userStatesMap: {},      // Statusy aktualnie zalogowanego gracza
    storySolversMap: {},    // Mapa story_id -> tablica user_id osób, które już ukończyły/rozwiązały sprawę
    currentStory: null,
    currentNodes: [],
    activeLeafNodeId: null, // Węzeł, od którego kontynuujemy w trybie Czarna Historia
    storyFilter: 'active',
    selectedNewGameMode: 'black_story'
};

// Zestaw ID węzłów aktualnie rozwiniętych przez użytkownika w trakcie sesji
const expandedNodeIds = new Set();

// ============================================================================
// ROUTING SPA (SEKWENCJA: SPLASH -> LOGIN -> DASHBOARD -> STORY)
// ============================================================================
function switchTab(tabId) {
    document.querySelectorAll('.app-tab').forEach(el => {
        el.classList.remove('active');
        el.classList.add('d-none');
    });
    const target = document.getElementById(tabId);
    if (target) {
        target.classList.remove('d-none');
        target.classList.add('active');
    }
}

async function initApp() {
    try {
        await loadUsers();
    } catch (err) {
        console.error('Błąd inicjalizacji listy graczy:', err);
    }

    const savedUserJson = localStorage.getItem(STORAGE_KEYS.USER);

    setTimeout(async () => {
        if (savedUserJson) {
            try {
                state.currentUser = JSON.parse(savedUserJson);
                updateUserBadge();
                switchTab('tab-dashboard');
                await loadDashboardData();
                return;
            } catch (e) {
                console.error('Błąd odtwarzania sesji:', e);
                localStorage.removeItem(STORAGE_KEYS.USER);
            }
        }
        switchTab('tab-login');
    }, 800);
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
// DASHBOARD (LISTA HISTORII + STATUSY + KTO JUŻ ROZWIĄZAŁ)
// ============================================================================
async function loadDashboardData() {
    const listContainer = document.getElementById('stories-list');
    listContainer.innerHTML = '<div class="text-center text-secondary py-4"><div class="spinner-border spinner-border-sm text-danger"></div></div>';

    const [{ data: stories, error: sErr }, { data: allCompletedStates }, { data: solutionNodes }] = await Promise.all([
        supabaseClient
            .from('ch_stories')
            .select('id, title, public_intro, created_by, created_at, game_mode')
            .order('created_at', { ascending: false }),
        supabaseClient
            .from('ch_user_story_states')
            .select('*'),
        supabaseClient
            .from('ch_nodes')
            .select('story_id, author_id')
            .eq('visibility', 'spoiler_solution')
    ]);

    if (sErr) {
        listContainer.innerHTML = `<div class="alert alert-danger">Błąd ładowania spraw: ${sErr.message}</div>`;
        return;
    }

    state.stories = stories || [];
    state.userStatesMap = {};
    state.storySolversMap = {};

    // Zbieramy statusy własne oraz listę osób, które zamknęły sprawę
    (allCompletedStates || []).forEach(st => {
        if (st.user_id === state.currentUser.id) {
            state.userStatesMap[st.story_id] = st;
        }
        if (st.is_completed === true) {
            if (!state.storySolversMap[st.story_id]) state.storySolversMap[st.story_id] = new Set();
            state.storySolversMap[st.story_id].add(st.user_id);
        }
    });

    // Dodajemy również osoby, które oznaczyły swój wpis jako 'spoiler_solution'
    (solutionNodes || []).forEach(node => {
        if (!state.storySolversMap[node.story_id]) state.storySolversMap[node.story_id] = new Set();
        state.storySolversMap[node.story_id].add(node.author_id);
    });

    renderStoriesList();
}

function getSolversNamesHtml(storyId) {
    const solverIds = state.storySolversMap[storyId] ? Array.from(state.storySolversMap[storyId]) : [];
    if (solverIds.length === 0) return '';

    const names = solverIds
        .map(uid => state.usersMap[uid]?.username)
        .filter(Boolean);

    if (names.length === 0) return '';

    return `
        <span class="solvers-pill" title="Osoby, które dotarły już do rozwiązania">
            <i class="bi bi-trophy-fill text-warning"></i> Rozwiązali: <strong>${escapeHtml(names.join(', '))}</strong>
        </span>
    `;
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
        const isCrime = story.game_mode === 'crime_investigation';
        const modeBadge = isCrime
            ? '<span class="badge bg-info text-dark"><i class="bi bi-folder-symlink me-1"></i>Śledztwo Kryminalne</span>'
            : '<span class="badge bg-danger"><i class="bi bi-incognito me-1"></i>Czarna Historia</span>';
        const solversHtml = getSolversNamesHtml(story.id);

        return `
            <div class="card story-card shadow-sm" onclick="openStory('${story.id}')">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
                        <div class="d-flex align-items-center gap-2">
                            ${modeBadge}
                            <span class="badge bg-secondary-subtle text-secondary-emphasis">${dateStr}</span>
                        </div>
                        ${solversHtml}
                    </div>
                    <h3 class="h6 fw-bold mb-1 text-light">${escapeHtml(story.title)}</h3>
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
// WYBÓR TRYBU I TWORZENIE NOWEJ HISTORII
// ============================================================================
document.querySelectorAll('#game-mode-selector .mode-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#game-mode-selector .mode-choice-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.selectedNewGameMode = btn.dataset.mode;
    });
});

document.getElementById('btn-confirm-create-story').addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-create-story');
    const theme = document.getElementById('story-theme-input').value.trim();

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Mistrz Gry przygotowuje sprawę...';

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
                game_mode: state.selectedNewGameMode,
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
        alert('Nie udało się wygenerować sprawy: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-stars me-1"></i>Generuj sprawę';
    }
});

// ============================================================================
// WIDOK ŚLEDZTWA, SYNCHRONIZACJA I OŚ CZASU PYTAŃ
// ============================================================================
async function openStory(storyId) {
    state.currentStory = state.stories.find(s => s.id === storyId);
    if (!state.currentStory) return;

    const isCrime = state.currentStory.game_mode === 'crime_investigation';

    document.getElementById('story-title').textContent = state.currentStory.title;
    document.getElementById('story-intro').textContent = state.currentStory.public_intro;
    document.getElementById('story-meta-date').textContent = new Date(state.currentStory.created_at).toLocaleDateString('pl-PL');

    // Plakietka trybu oraz informacja kto już rozwiązał
    const modeBadgeEl = document.getElementById('story-mode-badge');
    if (isCrime) {
        modeBadgeEl.className = 'badge bg-info text-dark';
        modeBadgeEl.innerHTML = '<i class="bi bi-folder-symlink me-1"></i>Śledztwo Kryminalne';
        document.getElementById('branch-indicator').classList.add('d-none');
        document.getElementById('question-input-label').textContent = 'Twój ruch w śledztwie (przesłuchaj świadka, sprawdź ślad lub przedstaw oskarżenie):';
        document.getElementById('question-input').placeholder = 'Np. Podchodzę do recepcjonisty i pytam, kto ostatni wchodził na piętro przed północą...';
    } else {
        modeBadgeEl.className = 'badge bg-danger';
        modeBadgeEl.innerHTML = '<i class="bi bi-incognito me-1"></i>Czarna Historia';
        document.getElementById('branch-indicator').classList.remove('d-none');
        document.getElementById('question-input-label').textContent = 'Zadaj pytanie Mistrzowi Gry (najlepiej tak/nie lub o szczegóły zdarzenia):';
        document.getElementById('question-input').placeholder = 'Np. Czy ofiara znała sprawcę przed dniem zdarzenia?';
    }

    document.getElementById('story-solvers-banner').innerHTML = getSolversNamesHtml(storyId);

    // Wszystkie karty domyślnie zwinięte po wejściu do sprawy
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
    if (!state.activeLeafNodeId && state.currentNodes.length > 0) {
        state.activeLeafNodeId = state.currentNodes[state.currentNodes.length - 1].id;
    }

    // Aktualizujemy na żywo listę osób, które oznaczyły rozwiązanie w tej sprawie
    state.currentNodes.forEach(n => {
        if (n.visibility === 'spoiler_solution') {
            if (!state.storySolversMap[state.currentStory.id]) state.storySolversMap[state.currentStory.id] = new Set();
            state.storySolversMap[state.currentStory.id].add(n.author_id);
        }
    });
    document.getElementById('story-solvers-banner').innerHTML = getSolversNamesHtml(state.currentStory.id);

    renderNodesTimeline();
}

function renderNodesTimeline() {
    const container = document.getElementById('nodes-timeline');
    const branchLabel = document.getElementById('branch-label');
    const resetBranchBtn = document.getElementById('btn-reset-branch');
    const isCrime = state.currentStory.game_mode === 'crime_investigation';

    if (state.currentNodes.length === 0) {
        container.innerHTML = '<p class="text-center text-secondary small py-3">Brak wpisów w tej sprawie. Rozpocznij śledztwo poniżej!</p>';
        branchLabel.textContent = 'Start śledztwa (Opis główny)';
        resetBranchBtn.classList.add('d-none');
        return;
    }

    if (!isCrime) {
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
    }

    container.innerHTML = state.currentNodes.map((node, index) => {
        const author = state.usersMap[node.author_id] || { username: 'Gracz', avatar_color: '#6c757d' };
        const isMine = node.author_id === state.currentUser.id;
        const isSelectedParent = !isCrime && node.id === state.activeLeafNodeId;
        const stepNumber = index + 1;
        const isExpanded = expandedNodeIds.has(node.id);

        // Plakietka statusu i klasa obramowania karty
        let badgeHtml = '';
        let cardTypeClass = '';
        if (node.visibility === 'spoiler_clue') {
            badgeHtml = '<span class="badge bg-warning text-dark"><i class="bi bi-lightbulb-fill me-1"></i>Wskazówka</span>';
            cardTypeClass = 'is-clue';
        } else if (node.visibility === 'spoiler_solution') {
            badgeHtml = '<span class="badge bg-danger"><i class="bi bi-bullseye me-1"></i>Rozwiązanie</span>';
            cardTypeClass = 'is-solution';
        }

        // Panel oznaczania po fakcie (tylko dla autora danego pytania, bez opcji "Prywatne")
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
            </div>
        ` : '';

        // Przycisk rozwidlania widoczny wyłącznie w trybie Czarna Historia
        const forkButtonHtml = !isCrime ? `
            <button class="btn btn-outline-info btn-sm py-0 px-2" style="font-size: 0.75rem;" onclick="forkFromNode('${node.id}')" title="Kontynuuj śledztwo od tego momentu (Git Fork)">
                <i class="bi bi-diagram-2"></i> Rozwidlij stąd
            </button>
        ` : '';

        const stepLabel = isCrime ? `Ruch #${stepNumber}` : `Pytanie #${stepNumber}`;
        const questionPrefix = isCrime ? 'Detektyw:' : 'Pytanie:';
        const answerPrefix = isCrime ? 'Akta / Postacie:' : 'AI:';

        return `
            <div class="card node-card ${cardTypeClass} ${isSelectedParent ? 'is-active-parent' : ''}">
                <div class="card-body py-2 px-3">
                    <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                        <div class="d-flex align-items-center gap-2 flex-grow-1" style="cursor: pointer;" onclick="toggleNodeReveal('${node.id}')">
                            <span class="avatar-dot" style="background-color: ${author.avatar_color};">${author.username[0]}</span>
                            <strong class="small text-light">${escapeHtml(author.username)} — ${stepLabel}</strong>
                            ${badgeHtml}
                            <i id="node-chevron-${node.id}" class="bi ${isExpanded ? 'bi-chevron-up' : 'bi-chevron-down'} text-secondary small ms-1"></i>
                        </div>
                        ${forkButtonHtml}
                    </div>
                    <div id="node-secret-body-${node.id}" class="${isExpanded ? '' : 'd-none'} mt-2 pt-2 border-top border-secondary-subtle">
                        <p class="mb-2 fw-semibold text-info-emphasis small">${questionPrefix} ${escapeHtml(node.question_text)}</p>
                        <div class="border-top border-secondary-subtle pt-2 small ai-narrative-text">
                            <span class="text-danger fw-bold me-1">${answerPrefix}</span> <span class="text-light">${escapeHtml(node.ai_answer_text)}</span>
                        </div>
                        ${ownerControlsHtml}
                    </div>
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

// Zmiana oznaczenia wpisu (Zwykły / Wskazówka / Rozwiązanie) po poznaniu odpowiedzi AI
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

    if (newVisibility === 'spoiler_solution') {
        if (!state.storySolversMap[state.currentStory.id]) state.storySolversMap[state.currentStory.id] = new Set();
        state.storySolversMap[state.currentStory.id].add(state.currentUser.id);
        document.getElementById('story-solvers-banner').innerHTML = getSolversNamesHtml(state.currentStory.id);
    }

    renderNodesTimeline();
};

// Rozwidlanie ścieżki śledztwa (Git Fork - tylko Czarna Historia)
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
                visibility: 'public'
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

    if (!state.storySolversMap[storyId]) state.storySolversMap[storyId] = new Set();
    if (newStatus) {
        state.storySolversMap[storyId].add(state.currentUser.id);
    } else {
        state.storySolversMap[storyId].delete(state.currentUser.id);
    }

    document.getElementById('story-solvers-banner').innerHTML = getSolversNamesHtml(storyId);
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