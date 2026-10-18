  btnClearChat.title = t('ui.messageEdit.clearConversation', '清空聊天记录');
  btnClearChat.setAttribute('aria-label', btnClearChat.title);
  btnClearChat.setAttribute('data-i18n-title', 'ui.messageEdit.clearConversation'); btnClearChat.setAttribute('data-i18n-aria-label', 'ui.messageEdit.clearConversation');
  btnClearChat.addEventListener('click', () => {
    window.CibypMessages.remove({mode:'chat', all:true}).catch(error => showToast(error.message, 'error'));
  });
