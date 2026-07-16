#include "nlohmann/json.hpp"
#include "llama.h"
#include "mtmd-helper.h"
#include "mtmd.h"

#include <clocale>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;

namespace {

constexpr const char * kModelId =
    "ggml-org/SmolVLM2-500M-Video-Instruct-GGUF:Q8_0";
constexpr const char * kModelFilename =
    "SmolVLM2-500M-Video-Instruct-Q8_0.gguf";
constexpr const char * kProjectorFilename =
    "mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf";
constexpr int kContextTokens = 8192;
constexpr int kBatchTokens = 512;
constexpr int kMaxInputs = 16;
constexpr int kMaxPromptBytes = 32'000;

struct MtmdDeleter {
    void operator()(mtmd_context * value) const {
        if (value != nullptr) {
            mtmd_free(value);
        }
    }
};

struct BitmapDeleter {
    void operator()(mtmd_bitmap * value) const {
        if (value != nullptr) {
            mtmd_bitmap_free(value);
        }
    }
};

struct SamplerDeleter {
    void operator()(llama_sampler * value) const {
        if (value != nullptr) {
            llama_sampler_free(value);
        }
    }
};

struct ModelDeleter {
    void operator()(llama_model * value) const {
        if (value != nullptr) {
            llama_model_free(value);
        }
    }
};

struct ContextDeleter {
    void operator()(llama_context * value) const {
        if (value != nullptr) {
            llama_free(value);
        }
    }
};

using MtmdContext = std::unique_ptr<mtmd_context, MtmdDeleter>;
using Bitmap = std::unique_ptr<mtmd_bitmap, BitmapDeleter>;
using Sampler = std::unique_ptr<llama_sampler, SamplerDeleter>;
using Model = std::unique_ptr<llama_model, ModelDeleter>;
using LlamaContext = std::unique_ptr<llama_context, ContextDeleter>;

json read_json(const fs::path & path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("request is unavailable");
    }
    json value;
    stream >> value;
    return value;
}

void write_json(const fs::path & path, const json & value) {
    const fs::path temporary = path.string() + ".tmp";
    {
        std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
        if (!stream) {
            throw std::runtime_error("response is unavailable");
        }
        stream << value.dump();
        stream.flush();
        if (!stream) {
            throw std::runtime_error("response could not be written");
        }
    }
    fs::rename(temporary, path);
}

void quiet_log(enum ggml_log_level, const char *, void *) {}

std::string token_to_piece(const llama_vocab * vocab, llama_token token) {
    std::vector<char> buffer(256);
    int32_t size = llama_token_to_piece(
        vocab, token, buffer.data(), static_cast<int32_t>(buffer.size()), 0, true
    );
    if (size < 0) {
        buffer.resize(static_cast<size_t>(-size));
        size = llama_token_to_piece(
            vocab,
            token,
            buffer.data(),
            static_cast<int32_t>(buffer.size()),
            0,
            true
        );
    }
    if (size < 0) {
        throw std::runtime_error("generated token could not be decoded");
    }
    return std::string(buffer.data(), static_cast<size_t>(size));
}

std::string format_prompt(llama_model * model, const std::string & content) {
    const char * chat_template = llama_model_chat_template(model, nullptr);
    if (chat_template == nullptr) {
        throw std::runtime_error("model chat template is unavailable");
    }
    const llama_chat_message message = {"user", content.c_str()};
    int32_t size = llama_chat_apply_template(
        chat_template, &message, 1, true, nullptr, 0
    );
    if (size < 0) {
        throw std::runtime_error("model chat template could not be applied");
    }
    std::vector<char> buffer(static_cast<size_t>(size) + 1);
    size = llama_chat_apply_template(
        chat_template,
        &message,
        1,
        true,
        buffer.data(),
        static_cast<int32_t>(buffer.size())
    );
    if (size < 0) {
        throw std::runtime_error("model chat template could not be applied");
    }
    return std::string(buffer.data(), static_cast<size_t>(size));
}

void require_exact_keys(const json & value, const std::set<std::string> & expected) {
    if (!value.is_object() || value.size() != expected.size()) {
        throw std::runtime_error("request schema is invalid");
    }
    for (const auto & key : expected) {
        if (!value.contains(key)) {
            throw std::runtime_error("request schema is invalid");
        }
    }
}

void validate_request(const json & request) {
    require_exact_keys(
        request,
        {"detail", "inputs", "max_output_tokens", "prompt", "schema_version",
         "task", "temperature"}
    );
    if (request.at("schema_version") != 1) {
        throw std::runtime_error("request schema is invalid");
    }
    const auto & inputs = request.at("inputs");
    if (!inputs.is_array() || inputs.empty() || inputs.size() > kMaxInputs) {
        throw std::runtime_error("input selection is invalid");
    }
    for (const auto & input : inputs) {
        if (!input.is_object() || !input.contains("path") ||
            !input.at("path").is_string()) {
            throw std::runtime_error("input selection is invalid");
        }
        const fs::path path = input.at("path").get<std::string>();
        if (!fs::is_regular_file(path) || fs::is_symlink(path)) {
            throw std::runtime_error("input image is unavailable");
        }
    }
    const std::string task = request.at("task").get<std::string>();
    if (task != "describe" && task != "question") {
        throw std::runtime_error("task is unsupported");
    }
    const std::string prompt = request.at("prompt").get<std::string>();
    if (prompt.empty() || prompt.size() > kMaxPromptBytes) {
        throw std::runtime_error("prompt is invalid");
    }
    const int max_output_tokens = request.at("max_output_tokens").get<int>();
    if (max_output_tokens < 1 || max_output_tokens > kContextTokens) {
        throw std::runtime_error("output limit is invalid");
    }
    const float temperature = request.at("temperature").get<float>();
    if (temperature < 0.0f || temperature > 2.0f) {
        throw std::runtime_error("temperature is invalid");
    }
    const std::string detail = request.at("detail").get<std::string>();
    if (detail != "auto" && detail != "low" && detail != "high" &&
        detail != "original") {
        throw std::runtime_error("detail is invalid");
    }
}

fs::path asset_root(const char * executable) {
    return fs::canonical(executable).parent_path().parent_path();
}

json infer(const json & request, const fs::path & root) {
    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0;
    model_params.use_mmap = true;
    model_params.use_mlock = false;
    model_params.use_extra_bufts = false;
    Model model(llama_model_load_from_file(
        (root / "models" / kModelFilename).string().c_str(), model_params
    ));
    if (!model) {
        throw std::runtime_error("language model could not be loaded");
    }
    llama_context_params context_params = llama_context_default_params();
    context_params.n_ctx = kContextTokens;
    context_params.n_batch = kBatchTokens;
    context_params.n_ubatch = kBatchTokens;
    context_params.n_threads = 1;
    context_params.n_threads_batch = 1;
    context_params.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    context_params.offload_kqv = false;
    context_params.op_offload = false;
    context_params.no_perf = true;
    LlamaContext context(llama_init_from_model(model.get(), context_params));
    if (!context) {
        throw std::runtime_error("language model context could not be created");
    }

    mtmd_context_params mtmd_params = mtmd_context_params_default();
    mtmd_params.use_gpu = false;
    mtmd_params.print_timings = false;
    mtmd_params.n_threads = 1;
    mtmd_params.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    mtmd_params.warmup = false;
    MtmdContext mtmd(mtmd_init_from_file(
        (root / "models" / kProjectorFilename).string().c_str(),
        model.get(),
        mtmd_params
    ));
    if (!mtmd) {
        throw std::runtime_error("vision projector could not be loaded");
    }
    if (!mtmd_support_vision(mtmd.get())) {
        throw std::runtime_error("vision projector is incompatible");
    }

    std::vector<Bitmap> bitmap_storage;
    std::vector<const mtmd_bitmap *> bitmaps;
    for (const auto & input : request.at("inputs")) {
        const std::string path = input.at("path").get<std::string>();
        mtmd_helper_bitmap_wrapper loaded =
            mtmd_helper_bitmap_init_from_file(mtmd.get(), path.c_str(), false);
        if (loaded.video_ctx != nullptr) {
            mtmd_helper_video_free(loaded.video_ctx);
            if (loaded.bitmap != nullptr) {
                mtmd_bitmap_free(loaded.bitmap);
            }
            throw std::runtime_error("video input is not supported");
        }
        if (loaded.bitmap == nullptr) {
            throw std::runtime_error("input image could not be decoded");
        }
        bitmap_storage.emplace_back(loaded.bitmap);
        bitmaps.push_back(loaded.bitmap);
    }

    std::string content;
    for (size_t index = 0; index < bitmaps.size(); ++index) {
        content += mtmd_default_marker();
    }
    content += request.at("prompt").get<std::string>();
    const std::string formatted = format_prompt(model.get(), content);

    mtmd_input_text input_text;
    input_text.text = formatted.data();
    input_text.text_len = formatted.size();
    input_text.add_special = true;
    input_text.parse_special = true;
    mtmd::input_chunks chunks(mtmd_input_chunks_init());
    if (mtmd_tokenize(
            mtmd.get(),
            chunks.ptr.get(),
            &input_text,
            bitmaps.data(),
            bitmaps.size()
        ) != 0) {
        throw std::runtime_error("multimodal prompt could not be tokenized");
    }

    llama_pos n_past = 0;
    if (mtmd_helper_eval_chunks(
            mtmd.get(),
            context.get(),
            chunks.ptr.get(),
            n_past,
            0,
            kBatchTokens,
            true,
            &n_past
        ) != 0) {
        throw std::runtime_error("multimodal prompt evaluation failed");
    }
    const int input_tokens = static_cast<int>(mtmd_helper_get_n_tokens(chunks.ptr.get()));

    llama_sampler_chain_params sampler_params = llama_sampler_chain_default_params();
    sampler_params.no_perf = true;
    Sampler sampler(llama_sampler_chain_init(sampler_params));
    if (!sampler) {
        throw std::runtime_error("sampler could not be initialized");
    }
    const float temperature = request.at("temperature").get<float>();
    if (temperature <= 0.0f) {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
    } else {
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_k(40));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_top_p(0.95f, 1));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_min_p(0.05f, 1));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_temp(temperature));
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_dist(0));
    }
    const llama_vocab * vocab = llama_model_get_vocab(model.get());
    std::string text;
    int output_tokens = 0;
    bool context_exhausted = false;
    const int max_output_tokens = request.at("max_output_tokens").get<int>();
    for (int index = 0; index < max_output_tokens; ++index) {
        const llama_token token = llama_sampler_sample(sampler.get(), context.get(), -1);
        llama_sampler_accept(sampler.get(), token);
        if (llama_vocab_is_eog(vocab, token)) {
            break;
        }
        text += token_to_piece(vocab, token);
        ++output_tokens;
        if (n_past + 1 >= static_cast<llama_pos>(llama_n_ctx(context.get()))) {
            context_exhausted = true;
            break;
        }
        llama_token next = token;
        llama_batch batch = llama_batch_get_one(&next, 1);
        if (llama_decode(context.get(), batch) != 0) {
            throw std::runtime_error("generated token evaluation failed");
        }
        ++n_past;
    }
    if (text.empty()) {
        throw std::runtime_error("model returned no text");
    }

    json warnings = json::array({
        "Local Vision candidate is optimized for English and may not read Chinese text reliably."
    });
    if (request.at("detail") != "auto") {
        warnings.push_back(
            "The current local candidate does not implement a separate detail policy."
        );
    }
    if (context_exhausted) {
        warnings.push_back("Generation stopped at the locked context limit.");
    }
    return {
        {"text", text},
        {"model_id", kModelId},
        {"usage", {
            {"input_tokens", input_tokens},
            {"output_tokens", output_tokens},
            {"total_tokens", input_tokens + output_tokens},
        }},
        {"warnings", warnings},
    };
}

}  // namespace

int main(int argc, char ** argv) {
    if (argc != 3) {
        std::cerr << "usage: vision-engine request.json response.json\n";
        return 2;
    }
    try {
        std::setlocale(LC_NUMERIC, "C");
        llama_log_set(quiet_log, nullptr);
        mtmd_helper_log_set(quiet_log, nullptr);
        llama_backend_init();
        const json request = read_json(argv[1]);
        validate_request(request);
        write_json(argv[2], infer(request, asset_root(argv[0])));
        llama_backend_free();
        return 0;
    } catch (const std::exception & error) {
        std::cerr << "vision-engine: " << error.what() << "\n";
        llama_backend_free();
        return 1;
    }
}
