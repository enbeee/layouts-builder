// Per-source crop-aware rounded corners + border. Applied to INPUT sources inside
// slot scenes (not scenes themselves, which don't render filters in live output).
uniform int corner_radius;
uniform int border_width;
uniform float4 border_color;
uniform float canvas_w;
uniform float canvas_h;
uniform float crop_left;
uniform float crop_right;
uniform float crop_top;
uniform float crop_bottom;

float4 mainImage(VertData v_in) : TARGET
{
    float4 src = image.Sample(textureSampler, v_in.uv);
    float2 px = v_in.uv * float2(canvas_w, canvas_h);

    float vl = crop_left * canvas_w;
    float vr = (1.0 - crop_right) * canvas_w;
    float vt = crop_top * canvas_h;
    float vb = (1.0 - crop_bottom) * canvas_h;

    float dx = min(px.x - vl, vr - px.x);
    float dy = min(px.y - vt, vb - px.y);

    if (dx < 0.0 || dy < 0.0)
        return float4(0.0, 0.0, 0.0, 0.0);

    float cr = (float)corner_radius;
    float bw = (float)border_width;

    if (cr > 0.5 && dx < cr && dy < cr) {
        float dist = distance(float2(dx, dy), float2(cr, cr));
        if (dist > cr) return float4(0.0, 0.0, 0.0, 0.0);
        if (bw > 0.5 && dist > cr - bw) return border_color;
    }
    if (bw > 0.5 && (dx < bw || dy < bw)) return border_color;

    return src;
}
