#ifndef AUDIOSCOPE_LOUDNESS_GRAPH_H
#define AUDIOSCOPE_LOUDNESS_GRAPH_H

#include <limits.h>
#include <stdio.h>

#include "libavfilter/avfilter.h"
#include "libavfilter/buffersink.h"
#include "libavfilter/buffersrc.h"
#include "libavfilter/f_ebur128.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/frame.h"
#include "libavutil/mem.h"
#include "libavutil/samplefmt.h"

struct hist_entry {
    unsigned count;
    double energy;
    double loudness;
};

struct integrator {
    double *cache;
    int cache_pos;
    int cache_size;
    double *sum;
    int filled;
    double rel_threshold;
    double sum_kept_powers;
    int nb_kept_powers;
    struct hist_entry *histogram;
};

struct rect {
    int x;
    int y;
    int w;
    int h;
};

typedef struct AudioscopeEbur128Context {
    const AVClass *class;
    EBUR128DSPContext dsp;
    int peak_mode;
    double true_peak;
    double *true_peaks;
    double sample_peak;
    double *sample_peaks;
    double *true_peaks_per_frame;
#if CONFIG_SWRESAMPLE
    SwrContext *swr_ctx;
    double *swr_buf;
    int swr_linesize;
#endif
    int do_video;
    int w;
    int h;
    struct rect text;
    struct rect graph;
    struct rect gauge;
    AVFrame *outpicref;
    int meter;
    int scale_range;
    int y_zero_lu;
    int y_opt_max;
    int y_opt_min;
    int *y_line_ref;
    int nb_channels;
    double *ch_weighting;
    int sample_count;
    int nb_samples;
    int idx_insample;
    AVFrame *insamples;
    struct integrator i400;
    struct integrator i3000;
    double integrated_loudness;
    double loudness_range;
    double lra_low;
    double lra_high;
    int loglevel;
    int metadata;
    int dual_mono;
    double pan_law;
    int target;
    int gauge_type;
    int scale;
} AudioscopeEbur128Context;

typedef struct ConvertedFrameCache {
    AVFrame *frame;
    int allocated_samples;
} ConvertedFrameCache;

static inline int audioscope_drain_filter_sink(AVFilterContext *sink_context, AVFrame *sink_frame) {
    while (1) {
        int result = av_buffersink_get_frame(sink_context, sink_frame);

        if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) {
            return result;
        }

        if (result < 0) {
            return result;
        }

        av_frame_unref(sink_frame);
    }
}

static inline int audioscope_create_loudness_graph(
    AVFilterGraph **graph_out,
    AVFilterContext **source_out,
    AVFilterContext **ebur128_out,
    AVFilterContext **sink_out,
    int sample_rate,
    const AVChannelLayout *channel_layout
) {
    AVFilterGraph *graph = NULL;
    AVFilterContext *source_context = NULL;
    AVFilterContext *ebur128_context = NULL;
    AVFilterContext *sink_context = NULL;
    char source_args[512];
    char channel_layout_description[128];
    int result;

    const AVFilter *buffer_source = avfilter_get_by_name("abuffer");
    const AVFilter *buffer_sink = avfilter_get_by_name("abuffersink");
    const AVFilter *ebur128_filter = avfilter_get_by_name("ebur128");

    if (buffer_source == NULL || buffer_sink == NULL || ebur128_filter == NULL) {
        return AVERROR_FILTER_NOT_FOUND;
    }

    result = av_channel_layout_describe(channel_layout, channel_layout_description, sizeof(channel_layout_description));
    if (result < 0) {
        return result;
    }

    snprintf(
        source_args,
        sizeof(source_args),
        "time_base=1/%d:sample_rate=%d:sample_fmt=%s:channel_layout=%s",
        sample_rate,
        sample_rate,
        av_get_sample_fmt_name(AV_SAMPLE_FMT_DBL),
        channel_layout_description
    );

    graph = avfilter_graph_alloc();
    if (graph == NULL) {
        return AVERROR(ENOMEM);
    }

    result = avfilter_graph_create_filter(&source_context, buffer_source, "in", source_args, NULL, graph);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_graph_create_filter(
        &ebur128_context,
        ebur128_filter,
        "loudness",
        "video=0:framelog=quiet:peak=sample+true",
        NULL,
        graph
    );
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_graph_create_filter(&sink_context, buffer_sink, "out", NULL, NULL, graph);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_link(source_context, 0, ebur128_context, 0);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_link(ebur128_context, 0, sink_context, 0);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    result = avfilter_graph_config(graph, NULL);
    if (result < 0) {
        avfilter_graph_free(&graph);
        return result;
    }

    *graph_out = graph;
    *source_out = source_context;
    *ebur128_out = ebur128_context;
    *sink_out = sink_context;
    return 0;
}

static inline int audioscope_ensure_converted_frame_capacity(
    ConvertedFrameCache *cache,
    const AVChannelLayout *output_layout,
    int output_sample_rate,
    int sample_count
) {
    int target_samples;
    int result;

    if (cache->frame == NULL) {
        cache->frame = av_frame_alloc();
        if (cache->frame == NULL) {
            return AVERROR(ENOMEM);
        }
    }

    if (cache->allocated_samples < sample_count) {
        if (cache->allocated_samples > 0 && cache->allocated_samples <= INT_MAX / 2) {
            target_samples = cache->allocated_samples * 2;
            if (target_samples < sample_count) {
                target_samples = sample_count;
            }
        } else {
            target_samples = sample_count;
        }

        av_frame_unref(cache->frame);
        cache->frame->format = AV_SAMPLE_FMT_DBL;
        cache->frame->nb_samples = target_samples;
        cache->frame->sample_rate = output_sample_rate;

        result = av_channel_layout_copy(&cache->frame->ch_layout, output_layout);
        if (result < 0) {
            return result;
        }

        result = av_frame_get_buffer(cache->frame, 0);
        if (result < 0) {
            return result;
        }

        cache->allocated_samples = target_samples;
    } else {
        result = av_frame_make_writable(cache->frame);
        if (result < 0) {
            return result;
        }
    }

    cache->frame->nb_samples = sample_count;
    cache->frame->sample_rate = output_sample_rate;
    return 0;
}

#endif
