(function () {
  'use strict';

  function enhanceIsolationHistory() {
    var tbody = document.getElementById('historique-tbody');
    if (!tbody) return;

    var table = tbody.closest('table');
    var wrap = table && table.closest('.banniere-historique-table');
    if (!table || !wrap) return;

    wrap.classList.add('iso-history-enhanced');

    if (!document.getElementById('iso-history-ui-style')) {
      var style = document.createElement('style');
      style.id = 'iso-history-ui-style';
      style.textContent = `
        .banniere-historique-table.iso-history-enhanced {
          max-height: 320px !important;
          overflow-y: auto !important;
          overflow-x: auto !important;
          position: relative !important;
          scrollbar-gutter: stable;
        }

        .banniere-historique-table.iso-history-enhanced table {
          border-collapse: separate !important;
          border-spacing: 0 !important;
        }

        .banniere-historique-table.iso-history-enhanced thead th {
          position: sticky !important;
          top: 0 !important;
          z-index: 10 !important;
          background: #f4f8f5 !important;
          color: #445249 !important;
          box-shadow: 0 1px 0 rgba(0,0,0,.08), 0 4px 8px rgba(0,0,0,.06) !important;
        }

        .banniere-historique-table.iso-history-enhanced thead th:first-child {
          border-top-left-radius: 7px;
        }

        .banniere-historique-table.iso-history-enhanced thead th:last-child {
          border-top-right-radius: 7px;
        }

        @media (max-width: 767px) {
          .banniere-historique-table.iso-history-enhanced {
            max-height: 280px !important;
          }
        }
      `;
      document.head.appendChild(style);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceIsolationHistory, { once: true });
  } else {
    enhanceIsolationHistory();
  }
})();
