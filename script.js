const DB = {
    db: null, name: 'BestdoriDB', version: 2,
    async open() {
        return new Promise((resolve, reject) => {
            if (this.db) return resolve(this.db);
            const request = indexedDB.open(this.name, this.version);
            request.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('bands')) db.createObjectStore('bands');
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
            };
            request.onsuccess = e => { this.db = e.target.result; resolve(this.db); };
            request.onerror = e => reject(e.target.error);
        });
    },
    async get(storeName, key) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        return new Promise((resolve, reject) => { tx.onsuccess = () => resolve(tx.result); tx.onerror = () => reject(tx.error); });
    },
    async set(storeName, key, value) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key);
        return new Promise((resolve, reject) => { tx.onsuccess = () => resolve(tx.result); tx.onerror = () => reject(tx.error); });
    },
    async bulkSet(storeName, items) {
        await this.open();
        const tx = this.db.transaction(storeName, 'readwrite');
        items.forEach(item => tx.objectStore(storeName).put(item));
        return new Promise(resolve => tx.oncomplete = resolve);
    },
    async clear() {
        return new Promise((resolve, reject) => {
            if (this.db) { this.db.close(); this.db = null; }
            const request = indexedDB.deleteDatabase(this.name);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
            request.onblocked = () => alert("数据库连接未关闭，请刷新页面后重试。");
        });
    }
};
const App = {
// 此处建议自行搭建代理使用
    PROXY_URL: 'https://cimfile.pages.dev/', API_BASE: 'https://bestdori.com/api/', ASSET_BASE: 'https://bestdori.com/assets/',
    SERVER: 'jp', SERVER_INDEX: 0, DIFFICULTY_MAP: ['easy', 'normal', 'hard', 'expert', 'special'],
    ITEM_HEIGHT: 236, RENDER_BUFFER: 5,
    songIndex: [], filteredSongIds: [], isFetching: false, downloadingSongs: new Set(), dom: {},
    async init() {
        this.dom = {
            status: document.getElementById('status'), songListSizer: document.getElementById('song-list-sizer'),
            songList: document.getElementById('song-list'), searchInput: document.getElementById('search-input'),
            updateButton: document.getElementById('update-button'), clearCacheButton: document.getElementById('clear-cache-button'),
            backToTopButton: document.getElementById('back-to-top'),
        };
        this.bindEvents();
        try { await this.loadInitialData(); } 
        catch (error) { console.error("初始化失败：", error); this.dom.status.textContent = `应用初始化失败： ${error.message}`; }
    },
    bindEvents() {
        this.dom.updateButton.addEventListener('click', () => this.fetchData(true));
        this.dom.clearCacheButton.addEventListener('click', this.clearCache.bind(this));
        this.dom.searchInput.addEventListener('input', this.handleSearch.bind(this));
        window.addEventListener('scroll', () => this.renderVisibleItems(), { passive: true });
        window.addEventListener('scroll', () => this.toggleBackToTopButton(), { passive: true });
        this.dom.backToTopButton.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    },
    async loadInitialData() {
        this.dom.status.textContent = '连接本地数据库中...';
        const searchIndex = await DB.get('meta', 'searchIndex');
        if (searchIndex && searchIndex.length > 0) {
            this.songIndex = searchIndex;
            this.prepareRender();
        } else {
            await this.fetchData(false);
        }
    },
    async fetchData(isUpdate = false) {
        if (this.isFetching) return;
        this.isFetching = true;
        this.dom.updateButton.disabled = true;
        this.dom.status.textContent = isUpdate ? '检查更新数据中...' : '首次进入，获取服务器数据中...';
        try {
            const remoteSongsIndex = await this.fetchWithProxy(`${this.API_BASE}songs/all.0.json`);
            const remoteSongIds = Object.keys(remoteSongsIndex);
            const songIdsToFetch = isUpdate ? remoteSongIds.filter(id => !this.songIndex.some(s => s.id === id)) : remoteSongIds;
            if (isUpdate && songIdsToFetch.length === 0) {
                this.dom.status.textContent = '数据已为最新。'; this.prepareRender(); return;
            }
            this.dom.status.textContent = `发现了 ${songIdsToFetch.length} 首新曲目，加载中...`;
            const results = await Promise.allSettled(songIdsToFetch.map(id => this.fetchWithProxy(`${this.API_BASE}songs/${id}.json`)));
            const newSongs = [];
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') { newSongs.push({ id: songIdsToFetch[index], data: result.value }); } 
                else { console.warn(`获取曲目 ID ${songIdsToFetch[index]} 失败：`, result.reason); }
            });
            await DB.bulkSet('songs', newSongs);
            if (newSongs.length > 0 || !isUpdate) {
                const remoteBands = await this.fetchWithProxy(`${this.API_BASE}bands/all.1.json`);
                await DB.set('bands', 'all', remoteBands);
                const allSongsFromDB = await this.getAllSongsFromDB();
                this.songIndex = this.buildSearchIndex(allSongsFromDB, remoteBands);
                await DB.set('meta', 'searchIndex', this.songIndex);
            }
            this.prepareRender();
            this.dom.status.textContent = `操作完成！成功${isUpdate ? '更新' : '加载'} 了${newSongs.length} 首曲目。`;
        } catch (error) {
            console.error("数据获取失败：", error); this.dom.status.textContent = `数据获取失败：${error.message}`;
        } finally {
            this.isFetching = false; this.dom.updateButton.disabled = false;
        }
    },
    buildSearchIndex(songs, bands) {
        return songs.map(song => ({
            id: song.id,
            title: song.data?.musicTitle?.[this.SERVER_INDEX] ?? null,
            bandName: bands[song.data?.bandId]?.bandName?.[this.SERVER_INDEX] ?? ''
        }));
    },
    async getAllSongsFromDB() {
        await DB.open();
        const request = DB.db.transaction('songs', 'readonly').objectStore('songs').getAll();
        return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    },
    prepareRender() {
        this.filterAndSortSongs();
        this.dom.songListSizer.style.height = `${this.filteredSongIds.length * this.ITEM_HEIGHT}px`;
        this.renderVisibleItems();
        const count = this.filteredSongIds.length;
        this.dom.status.textContent = count > 0 ? `共 ${count} 首曲目。` : `未找到匹配的曲目。`;
    },
    async renderVisibleItems() {
        const scrollTop = window.scrollY;
        const viewportHeight = window.innerHeight;
        const startIndex = Math.max(0, Math.floor(scrollTop / this.ITEM_HEIGHT) - this.RENDER_BUFFER);
        const endIndex = Math.min(this.filteredSongIds.length - 1, Math.ceil((scrollTop + viewportHeight) / this.ITEM_HEIGHT) + this.RENDER_BUFFER);
        this.dom.songList.style.transform = `translateY(${startIndex * this.ITEM_HEIGHT}px)`;
        const visibleIds = this.filteredSongIds.slice(startIndex, endIndex + 1);
        const songsData = await Promise.all(visibleIds.map(id => DB.get('songs', id)));
        const bandsData = await DB.get('bands', 'all');
        let html = '';
        songsData.forEach(song => {
            if(song) html += this.createSongItemHTML(song.id, song.data, bandsData);
        });
        this.dom.songList.innerHTML = html;
    },
    createSongItemHTML(id, song, bands) {
        const bandName = bands[song?.bandId]?.bandName?.[this.SERVER_INDEX] ?? '获取乐队失败';
        const musicTitle = song?.musicTitle?.[this.SERVER_INDEX] ?? '获取歌名失败';
        const isLoading = this.downloadingSongs.has(id);
        let chartGroupsHtml = '';
        for (let i = 0; i < 5; i++) {
            const hasDifficulty = song?.difficulty?.[i];
            const difficultyName = this.DIFFICULTY_MAP[i].toUpperCase();
            chartGroupsHtml += `<div class="difficulty-group">
                <button class="dl-chart-${i}" onclick="App.handleDownload('${id}', 'chart', { difficultyIndex: ${i}, targetVersion: '7k' })" ${hasDifficulty ? '' : 'disabled'}>
                    <svg width="18" height="18"><use href="#icon-chart-7k"/></svg><span class="tooltip">下载谱面 ${difficultyName} Bestdori JSON</span>
                </button>
                <button class="dl-chart-${i}" onclick="App.handleDownload('${id}', 'chart', { difficultyIndex: ${i}, targetVersion: '6k' })" ${hasDifficulty ? '' : 'disabled'}>
                    <svg width="18" height="18"><use href="#icon-chart-6k"/></svg><span class="tooltip">下载谱面 ${difficultyName} Costell III JSON</span>
                </button>
            </div>`;
        }
        return `<div id="song-${id}" class="song-item ${isLoading ? 'card-loading' : ''}">
                <div class="song-info">
                    <div><div class="song-title">${musicTitle}</div><div class="song-band">${bandName}</div></div>
                    <div class="song-id">ID: ${id}</div>
                </div>
                <div class="download-section">
                    <div class="download-group"><span class="group-label">媒体类</span>
                        <button class="dl-music" onclick="App.handleDownload('${id}', 'music')"><svg width="18" height="18"><use href="#icon-music"/></svg><span class="tooltip">下载音乐 MP3</span></button>
                        <button class="dl-jacket" onclick="App.handleDownload('${id}', 'jacket')"><svg width="18" height="18"><use href="#icon-image"/></svg><span class="tooltip">下载封面 PNG</span></button>
                    </div><div class="download-group"><span class="group-label">谱面类</span>${chartGroupsHtml}</div>
                </div></div>`;
    },
    filterAndSortSongs() {
        const query = this.dom.searchInput.value.toLowerCase().trim();
        this.filteredSongIds = this.songIndex
            .filter(song => song.title && `${song.title} ${song.bandName} ${song.id}`.toLowerCase().includes(query))
            .map(song => song.id)
            .sort((a, b) => parseInt(a) - parseInt(b));
    },
    async clearCache() {
        if(confirm('确定清除么？将清空数据后刷新页面，后需重新从服务器获取文件。')) {
            await DB.clear();
            window.location.reload();
        }
    },
    handleSearch() { this.prepareRender(); },
    async handleDownload(songId, type, options = {}) {
        this.downloadingSongs.add(songId);
        const card = document.getElementById(`song-${songId}`);
        if(card) card.classList.add('card-loading');
        try {
            const [songData, bandsData] = await Promise.all([DB.get('songs', songId), DB.get('bands', 'all')]);
            const song = songData.data;
            const bandName = bandsData[song?.bandId]?.bandName?.[this.SERVER_INDEX] ?? 'Unknown';
            const musicTitle = song?.musicTitle?.[this.SERVER_INDEX] ?? 'Unknown';
            const baseFilename = `${this.sanitizeFilename(bandName)} - ${this.sanitizeFilename(musicTitle)}`;
            let blob, filename;
            switch (type) {
                case 'music': {
                    const url = `${this.ASSET_BASE}${this.SERVER}/sound/${song.bgmId}_rip/${song.bgmId}.mp3`;
                    blob = await this.fetchAsBlob(url); filename = `${baseFilename}.mp3`;
                    break;
                }
                case 'jacket': {
                    const jacketPkgId = Math.ceil(parseInt(songId) / 10) * 10;
                    const jacketImageName = song.jacketImage[0].replace('Introduction', 'introduction');
                    const url = `${this.ASSET_BASE}${this.SERVER}/musicjacket/musicjacket${jacketPkgId}_rip/assets-star-forassetbundle-startapp-musicjacket-musicjacket${jacketPkgId}-${jacketImageName}-jacket.png`;
                    blob = await this.fetchAsBlob(url); filename = `${baseFilename}.png`;
                    break;
                }
                case 'chart': {
                    const difficulty = this.DIFFICULTY_MAP[options.difficultyIndex];
                    const url = `${this.API_BASE}charts/${songId}/${difficulty}.json`;
                    const chart7kBlob = await this.fetchAsBlob(url);
                    if (options.targetVersion === '6k') {
                        const chart7kData = JSON.parse(await chart7kBlob.text());
                        const { convertedChart } = this.Converter.convert7kTo6kChart(chart7kData);
                        blob = new Blob([JSON.stringify(convertedChart)], { type: 'application/json' });
                        filename = `${baseFilename}_${difficulty}_bestdori.json`;
                    } else {
                        blob = chart7kBlob; filename = `${baseFilename}_${difficulty}_costell iii3.json`;
                    }
                    break;
                }
            }
            this.createDownloadLink(URL.createObjectURL(blob), filename, true);
        } catch (error) {
            alert(`下载失败：${error.message}`); console.error('Download failed:', error);
        } finally {
            this.downloadingSongs.delete(songId);
            const finalCard = document.getElementById(`song-${songId}`);
            if(finalCard) finalCard.classList.remove('card-loading');
        }
    },
    Converter: {
        convert7kTo6kChart(chartData) {
            const convertedChart = []; let droppedNotesCount = 0; let lastNoteSide = null; const activeRanges = [];
            for (const note of chartData) {
                if (note.type === 'BPM' || note.type === 'System') continue;
                const startBeat = note.beat ?? note.connections[0].beat;
                const endBeat = (note.type === 'Long' || note.type === 'Slide') ? note.connections[note.connections.length - 1].beat : startBeat;
                const lane = note.lane ?? note.connections[0].lane;
                activeRanges.push({ lane, startBeat, endBeat });
            }
            const isLaneOccupied = (lane, beat) => activeRanges.some(r => r.lane === lane && beat >= r.startBeat && beat <= r.endBeat);
            for (const note of chartData) {
                if (note.type === 'BPM' || note.type === 'System') { convertedChart.push(note); continue; }
                const newNote = JSON.parse(JSON.stringify(note));
                if (newNote.type === 'Single' || newNote.type === 'Directional') {
                    const originalLane = newNote.lane; let newLane;
                    if (originalLane < 3) { newLane = originalLane; } 
                    else if (originalLane > 3) { newLane = originalLane - 1; } 
                    else {
                        const beat = newNote.beat; const hasLeft = isLaneOccupied(2, beat); const hasRight = isLaneOccupied(4, beat);
                        if (hasLeft && hasRight) { droppedNotesCount++; continue; } 
                        else if (hasLeft) { newLane = 3; } else if (hasRight) { newLane = 2; } 
                        else { newLane = (lastNoteSide === 'left') ? 3 : 2; }
                    }
                    newNote.lane = newLane; lastNoteSide = newLane <= 2 ? 'left' : 'right';
                } else {
                    let startLaneDecision = null; const startLane = newNote.connections[0].lane;
                    if (startLane === 3) {
                        const beat = newNote.connections[0].beat; const hasLeft = isLaneOccupied(2, beat); const hasRight = isLaneOccupied(4, beat);
                        if (hasLeft && hasRight) { droppedNotesCount++; continue; } 
                        else if (hasLeft) { startLaneDecision = 3; } else if (hasRight) { startLaneDecision = 2; } 
                        else { startLaneDecision = (lastNoteSide === 'left') ? 3 : 2; }
                    }
                    for (let i = 0; i < newNote.connections.length; i++) {
                        const conn = newNote.connections[i]; const originalLane = conn.lane;
                        if (originalLane < 3) { conn.lane = originalLane; } 
                        else if (originalLane > 3) { conn.lane = originalLane - 1; } 
                        else { conn.lane = (i === 0) ? startLaneDecision : newNote.connections[i - 1].lane; }
                    }
                    lastNoteSide = newNote.connections[newNote.connections.length - 1].lane <= 2 ? 'left' : 'right';
                }
                convertedChart.push(newNote);
            }
            return { convertedChart, droppedNotesCount };
        }
    },
    async fetchWithProxy(url) {
        const response = await fetch(this.PROXY_URL + url);
        if (!response.ok) throw new Error(`请求失败：${response.status} for ${url}`);
        return response.json();
    },
    async fetchAsBlob(url) {
        const response = await fetch(this.PROXY_URL + url);
        if (!response.ok) throw new Error(`请求 Blob 失败：${response.status} for ${url}`);
        return response.blob();
    },
    sanitizeFilename: (input) => String(input).replace(/[\\/:*?"<>|]/g, '-'),
    createDownloadLink(url, filename, isBlob = false) {
        const a = document.createElement('a'); a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        if (isBlob) URL.revokeObjectURL(url);
    },
    toggleBackToTopButton() { this.dom.backToTopButton.style.display = (window.scrollY > 300) ? 'flex' : 'none'; }
};

document.addEventListener('DOMContentLoaded', () => App.init());

