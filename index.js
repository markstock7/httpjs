
/**
 * Since we've been using babel-polyfill in this project
 * So we don't need to worry about the browser compatibility
 *
 * @TODO 因为后端的错误格式没有统一，所有这里先使用then的reject来直接获取错误信息，
 * 待格式统一后可以编写各个错误的类 throw之后用 catch获取
 *
 * @TODO 添加更完善的参数类型检查机制
 *
 * @TODO 添加getLast实现，发送多次请求，只获取最后一次
 *
 * Usage:
 *   restful method:
 *     get, post, put, delete
 *
 *   return promise
 *
 *   默认返回 json数据
 *   http.get(url, options).then().then().finally();
 */
var fetch = require('isomorphic-fetch');
var url = require('url');
var _ =  require('lodash');
var Promise = require('bluebird');

var http;

/**
 * 默认支持的METHOD
 */
const SUPPORTEDMETHOD = ['GET', 'POST', 'PUT', 'DELETE'];

/**
 * 默认的选项
 */
const DEFAULTOPTIONS = {
  credentials: 'include',

  headers: {
    accept: 'application/json',
    'Content-Type': 'application/json'
  },

  /**
   * 最大尝试次数
   */
  maxRetryTimes: 1,

  /*
   * 尝试的间隔
   */
  retryInterval: 100,

  // 字符串或者对象，会被转换成为查询字符串追加的url后面
  params: {},

  // 在发送post请求时使用，作为消息体发送到服务器
  data: {}
};

let endpoint = '';

/**
 * 延迟执行一个propmise
 */
function promiseInterval(delay) {
  return new Promise((resolve) => {
    setTimeout(function _dealyFn() {
      resolve();
    }, delay);
  });
}

class Http {

  constructor(url, options, direct) {
    if (typeof options !== 'object') {
      options = {};
    }
    options = options || {};

    direct = !!direct;

    // response 的状态
    this.status = null;

    // 当前请求的类型 参考SUPPORTEDMETHOD
    this.method = options.method;

    if (SUPPORTEDMETHOD.indexOf(this.method) < 0) {
      throw new Error(`Http Method ${this.method} is illegal`);
    }

    // 利用defaultDeep可以深度赋值
    this.options = Object.assign(_.cloneDeep(DEFAULTOPTIONS), options);
    //fix params 和 data保存原样，避免defaultsDeep改变其类型
    this.options.params = options.params || this.options.params;
    this.options.data = options.data || this.options.data;

    this.originalOptions = this.options;

    /**
     * 当前尝试次数
     */
    this.retryTimes = 1;

    /**
     * 设置最大尝试次数
     */
    if (typeof options.maxRetryTimes === 'number' && !!options.maxRetryTimes) {
      this.maxRetryTimes = options.maxRetryTimes;
    } else {
      this.maxRetryTimes = 1;
    }

    this._formatUrl(url, direct);
    this._parseRequestParams();
    this._parserRequestData();

    // 去除不必要的参数
    this.options = _.omit(this.options, ['params', 'data', 'maxRetryTimes', 'retryInterval', 'filename']);
  }

  _formatUrl(url, direct) {
    if (direct) {
      this.url = url;
    } else {
      this.url = `${endpoint}${url}`;
    }
  }

  _parseRequestParams() {
    var urlData, params;
    if (this.options.params) {
      params = this.options.params;

      // 获取已有的params
      urlData = url.parse(this.url, true);
      urlData.query = Object.assign(urlData.query, params);

      // 这里我们将search删除掉，从新从query中计算search
      delete urlData.search;
      this.url = url.format(urlData);
    }

  }

  _parserRequestData() {
    var data = this.options.data;
    if (data && (this.method === 'POST' || this.method === 'PUT')) {
      this.options.body = JSON.stringify(data);
    }
  }

  /**
   * 开始执行ajax操作
   */
  run() {
    var { url, options } = this;
    return new Promise((resolve, reject) => {
      fetch(url, options)
        .then(this._firedResponseHandler.bind(this))
        .then(this._parseResponseData.bind(this))
        .then((data) => this._dispatchResponseData(data, resolve, reject));
    });
  }


  /**
   * 触发middleware
   */
  _firedResponseHandler(response) {
    /**
     * 把当前的http对象绑定到response中
     */
    response.currentHttp = this;
    return pipeline(Http.responseHandlers, response)
      .then(response => {
        return Promise.resolve(response);
      });
  }

  /**
   *  纪录返回的状态，并尝试解析出数据，如果失败则返回null
   */
  _parseResponseData(response) {
    this.status = response.status;
    return response.json()
      .then((data) => {
        return Promise.resolve(data);
      }, () => {
        /**
         * make sure we can always parse response data even it is null
         * error = {} !!error === true
         */
        return Promise.resolve({});
      });
  }

  /**
   * 根据status来dispath response data
   */
  _dispatchResponseData(data, resolve, reject) {
    if (this.status >= 200 && this.status < 300) {
      return resolve(data);
    }

    /**
     * 在所有的错误中加入状态码，用户可以跟状态码做额外操作
     */
    data.httpStatus = this.status;
    return reject(data);
  }

  static registerResponseHandler(fn) {
    if (typeof fn !== 'function') {
      throw new Error('Http method registerResponseHandler can only receive function');
    }
    if (!Http.responseHandlers) {
      Http.responseHandlers = [];
    }
    Http.responseHandlers.push(fn);
  }
}


/**
 * 当返回408 timeout时，如果尝试次数小于最大尝试次数，则重新发送请求获取数据，否则直接reject
 */
Http.registerResponseHandler(function _dealRetry(response, next) {
  var currentHttp = response.currentHttp;
  if (response.status === 408 && currentHttp.maxRetryTimes > currentHttp.retryTimes) {
    currentHttp.retryTimes++;

    /**
     * 下一个请求延迟 retryInterval 秒后执行
     */
    return promiseInterval(currentHttp.retryInterval)
      .then(function _resolve() {
        return currentHttp.run();
      });
  }
  return next(null, response);
});

/**
 *
 * 按照顺序执行promise，如果其中一个reject了，则中断
 *
 * @param tasks {Array} 为所需要执行的任务
 * @param initialValue {Any} 为初始化的参数, 会传递给第一个task
 */
function pipeline(tasks, ...initialValue) {
  var task, currentIndex = 0;
  if (!_.isArray(tasks)) throw new Error('pipeline only receive array as tasks type');

  /**
   * 开始执行下一个任务
   */
  function runNextTASK(...param) {
    var taskParamsLength;
    task = tasks[currentIndex++];
    if (task) {
      if (typeof task !== 'function') {
        throw new Error('http.pipeline receive a none function task');
      }
      /**
       *  对参数进行补全或截取
       *  每一个task的定义方式如下 function task(a, b[, ...], next)
       *  每个task的参数是通过上一个task手动传递下来的，为了上一个task传递的参数数量可以和下一个参数的数量匹配上，
       *  所以需要对参数进行补全或截取
       *
       *  如 在task1中调用next(null, 1);
       *  task2 的声明方式为 function task2(a, b, next);
       *
       *  如果不做处理，那么 a = 1, b = function next(), next = undefined
       *
       *  处理后 为 a = 1, b = undefined, next = function next()
       *
       *  有如 task1中调用next(null, 1, 2, 3)
       *
       *  如果不做处理， 那么 a = 1, b = 2, next = 3
       *
       *  处理后 a =1 ,b = 2, next = function next();
       *
       */
      taskParamsLength = task.length - 1;
      if (taskParamsLength <= param.length) {
        param = param.splice(0, taskParamsLength);
      } else {
        param = param.concat(_.fill(Array(Math.abs(taskParamsLength - param.length)), undefined));
      }

      return task(...param, next);
    }
    return Promise.resolve(...param);
  }

  function next(error, ...rest) {
    if (error) return Promise.reject(error);
    return runNextTASK(...rest);
  }

  return runNextTASK(...initialValue);
}

/**
 * 根据 SUPPORTEDMETHOD 来分别创建 与其相对应的接口
 * 如:
 * http.get, http.put, http.post, http.delete
 */
http =  (function httpFactory() {
  var outputs = {};

  SUPPORTEDMETHOD.forEach(method => {
    var upperCaseMethod = method;
    method = method && method.toLowerCase() || '';
    if (method) {
      /**
       * @param url {String} 要请求的字符串
       * @param options {Object} 请求的参数
       * @param direct {boolean} 是否直接寻址，为false则在当前项目的域名下寻址
       */
      outputs[method] = (url, options, direct = false) => {
        if (typeof url !== 'string' || !url) {
          throw new Error('Url must be a String and can not be empty');
        }
        if (typeof options === 'boolean') {
          options = {}; direct = options;
        }
        options = options || {};
        options.method = upperCaseMethod;
        return new Http(url, options, direct).run();
      };
    }
  });
  return outputs;
}());

http.resolve = function resolve(result) {
  return Promise.resolve(result);
};

http.reject = function reject(error) {
  return Promise.reject(error);
};

/**
 * @note reject的特殊版，可以从error中解析出错误信息
 */
http.error = function error(error) {
  if (_.isObject(error)) {
    let message = '';
    if (error.message) {
      message = error.message;
    } else if (error.errors && error.errors[0] && error.errors[0].message) {
      message = error.errors && error.errors[0] && error.errors[0].message;
    }
    return Promise.reject(message);
  }
  return Promise.reject(error);
};


http.pipeline = pipeline;

http.Http = Http;

http.init = (options) => {
  endpoint = options.endpoint;
};

module.exports = http;

