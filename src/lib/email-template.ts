const LOGO = 'https://cnpfyybiqoptkciXgpik.supabase.co/storage/v1/object/public/downloads/logo-collection.png';

export function wrapEmailHTML(content: string): string {
  return `<div style="font-family:Georgia,Inter,sans-serif;max-width:560px;margin:0 auto;background:#FAFAF7;padding:32px;border-radius:12px">
  <div style="text-align:center;margin-bottom:24px">
    <img src="${LOGO}" alt="Collection" style="width:48px;height:48px" />
  </div>
  ${content}
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
  <p style="font-size:12px;color:#999;text-align:center">Collection — O ecossistema completo para arquitetos<br/>
  <a href="https://collection.com.br" style="color:#999">collection.com.br</a></p>
</div>`;
}
