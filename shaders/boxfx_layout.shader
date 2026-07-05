// Layout-level box effects. Uses explicit canvas_w/canvas_h (NOT uv_size, which
// may not be set correctly by the plugin for all source types).
uniform int corner_radius;
uniform int border_width;
uniform float4 border_color;
uniform float canvas_w;
uniform float canvas_h;

uniform float b1_l; uniform float b1_t; uniform float b1_r; uniform float b1_b;
uniform float b2_l; uniform float b2_t; uniform float b2_r; uniform float b2_b;
uniform float b3_l; uniform float b3_t; uniform float b3_r; uniform float b3_b;
uniform float b4_l; uniform float b4_t; uniform float b4_r; uniform float b4_b;

float4 boxFx(float2 px, float bl, float bt, float br, float bb, float4 src) {
    float dx = min(px.x - bl, br - px.x);
    float dy = min(px.y - bt, bb - px.y);
    if (dx < 0.0 || dy < 0.0) return float4(-1.0, -1.0, -1.0, -1.0);
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

float4 mainImage(VertData v_in) : TARGET {
    float4 src = image.Sample(textureSampler, v_in.uv);
    float2 px = v_in.uv * float2(canvas_w, canvas_h);
    float4 r;
    r = boxFx(px, b1_l, b1_t, b1_r, b1_b, src); if (r.x >= 0.0) return r;
    r = boxFx(px, b2_l, b2_t, b2_r, b2_b, src); if (r.x >= 0.0) return r;
    r = boxFx(px, b3_l, b3_t, b3_r, b3_b, src); if (r.x >= 0.0) return r;
    r = boxFx(px, b4_l, b4_t, b4_r, b4_b, src); if (r.x >= 0.0) return r;
    return src;
}
