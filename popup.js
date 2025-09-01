document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('addPatternForm');
    const patternInput = document.getElementById('patternInput');
    const patternsList = document.getElementById('patternsList');
    const feedbackButton = document.getElementById('feedbackButton');

    const loadPatterns = async () => {
        await chrome.storage.sync.get(['patterns'], (result) => {
            const patterns = result.patterns || [];
            patternsList.innerHTML = '';
            patterns.forEach(pattern => {
                const li = document.createElement('li');
                const span = document.createElement('span');
                const removeButton = document.createElement('button');

                span.title = pattern;

                const maxLength = 40;
                if (pattern.length > maxLength) {
                    span.textContent = pattern.substring(0, maxLength - 3) + '...';
                } else {
                    span.textContent = pattern;
                }

                removeButton.className = "remove-button";
                removeButton.dataset.pattern = pattern;

                removeButton.innerHTML = `
                    <svg class="remove-icon" xmlns="http://www.w3.org/2000/svg"
                        height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3">
                        <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520
                        q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360
                        Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/>
                    </svg>
                `;
                li.appendChild(span);
                li.appendChild(removeButton);
                li.dataset.pattern = pattern;
                patternsList.appendChild(li);
            });
        });
    };

    const isValidUrlPattern = (pattern) => {
      const regex = /^((https?|ftp|sftp|ftps|mailto):\/\/)?([\w\*-]+\.)+[\w-]+([\/\?#]\S*)?$/;
      return regex.test(pattern);
    };

    loadPatterns();

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const newPattern = patternInput.value.trim();
        if (newPattern) {
            if (!isValidUrlPattern(newPattern)) {
                const patternErrorMessage = 'Valid examples are:\nhttps://www.google.com\ngoogle.com\n*index.html\n*.com\ngoogle.com/search';
                alert(patternErrorMessage);
                return;
            }

            await chrome.storage.sync.get(['patterns'], async (result) => {
                const patterns = result.patterns || [];

                if (!patterns.includes(newPattern)) {
                    patterns.push(newPattern);
                    await chrome.storage.sync.set({ patterns }, () => {
                        patternInput.value = '';
                        loadPatterns();
                        chrome.runtime.sendMessage({
                            action: 'groupTabs',
                            pattern: newPattern
                        });
                    });
                } else {
                    chrome.runtime.sendMessage({
                        action: 'groupTabs',
                        pattern: newPattern
                    });
                    patternInput.value = '';
                }
            });
        }
    });

    patternsList.addEventListener('click', async (event) => {
        const removeButton = event.target.closest('.remove-button');
        if (removeButton) {
            const patternToRemove = removeButton.dataset.pattern;

            await chrome.runtime.sendMessage({
                action: 'ungroupTabs',
                pattern: patternToRemove
            });

            await chrome.storage.sync.get(['patterns'], async (result) => {
                const patterns = result.patterns || [];
                const newPatterns = patterns.filter(p => p !== patternToRemove);
                await chrome.storage.sync.set({ patterns: newPatterns }, () => {
                    loadPatterns();
                });
            });
        }
    });

    feedbackButton.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://github.com/FVPukay/url-pattern-tab-manager/issues' });
    });
});
